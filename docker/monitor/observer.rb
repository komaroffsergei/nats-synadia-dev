# frozen_string_literal: true
# Observation only. No network operation is performed on the proxy relay thread.
require 'json'
require 'securerandom'
require 'digest'
require 'fileutils'
require 'time'
require 'thread'
require 'zlib'

module CodexMonitor
  REDACTED = '[скрыто]'
  MAX_ITEM = 2 * 1024 * 1024

  def self.clean(value)
    text = value.to_s.encode('UTF-8', invalid: :replace, undef: :replace)
    text = text.gsub(/(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{6,}/, REDACTED)
    text = text.gsub(/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]*)?/, REDACTED)
    text = text.gsub(/\b(Bearer|Basic)\s+[A-Za-z0-9+\/_=.\-]+/i, '\1 ' + REDACTED)
    # Quoted passwords may contain spaces; redact incomplete quoted values too.
    text = text.gsub(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|\z)|'(?:\\.|[^'\\])*(?:'|\z))/i, '\1' + REDACTED)
    text = text.gsub(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie)\s*["']?\s*[:=]\s*["']?)([^\s"'`,;}]+)/i, '\1' + REDACTED)
    text = text.gsub(%r{(https?://)[^\s/:@]+:[^\s/@]+@}, '\1' + REDACTED + '@')
    # High-entropy credential-like tokens; ordinary prose and short source IDs survive.
    text.gsub(/\b(?=[A-Za-z0-9_\-]{32,}\b)(?=[A-Za-z0-9_\-]*[a-z])(?=[A-Za-z0-9_\-]*[A-Z])(?=[A-Za-z0-9_\-]*\d)[A-Za-z0-9_\-]+\b/, REDACTED)
  end

  class Sink
    def initialize(directory, max_bytes: 268_435_456, queue_size: 1024)
      @directory, @max_bytes = directory, max_bytes
      @queue = SizedQueue.new(queue_size)
      @epoch = SecureRandom.uuid
      @started_at = Time.now.utc.iso8601(6)
      @seq, @dropped, @written, @bytes = 0, 0, 0, 0
      @mutex = Mutex.new
      @worker = Thread.new { work }
      @worker.report_on_exception = false
    end

    def emit(scope, type, data)
      event = @mutex.synchronize do
        @seq += 1
        { version: 1, eventId: "#{@epoch}:#{@seq}", producer: 'codex-proxy', epoch: @epoch,
          sequence: @seq, at: Time.now.utc.iso8601(6), type: type, **scope, data: data }
      end
      @queue.push(event, true)
      true
    rescue ThreadError, StandardError
      @mutex.synchronize { @dropped += 1 }
      false
    end

    def drain(timeout = 5)
      deadline = Time.now + timeout
      sleep 0.01 until (@queue.empty? && !@busy) || Time.now > deadline
    end

    def stop
      drain
      @worker.kill
    end

    def work
      FileUtils.mkdir_p(@directory, mode: 0o700)
      last_scan = 0
      loop do
        @busy = false
        event = @queue.pop
        @busy = true
        if Time.now.to_f - last_scan > 0.5
          @bytes = Dir.glob(File.join(@directory, '*.json')).sum { |p| File.size(p) rescue 0 }
          last_scan = Time.now.to_f
        end
        if @dropped.positive?
          health = { at: Time.now.utc.iso8601(6), dropped: @dropped, queued: @queue.length, outboxBytes: @bytes }
          atomic_write(File.join(@directory, 'health.state'), JSON.generate(health))
        end
        content = JSON.generate(event)
        if @bytes + content.bytesize > @max_bytes
          @mutex.synchronize { @dropped += 1 }
          next
        end
        if event[:type] == 'source.status'
          event[:data][:deliveryDropped] = @dropped
          event[:data][:epochStartedAt] = @started_at
        end
        filename = format('%020d-%s.json', event[:sequence], @epoch)
        atomic_write(File.join(@directory, filename), JSON.generate(event))
        @bytes += content.bytesize
        @written += 1
        atomic_write(File.join(@directory, 'health.state'), JSON.generate({ at: Time.now.utc.iso8601(6),
          dropped: @dropped, queued: @queue.length, written: @written, outboxBytes: @bytes }))
      rescue StandardError
        @mutex.synchronize { @dropped += 1 }
        sleep 0.05
      end
    end

    def atomic_write(path, content)
      tmp = path + '.tmp'
      File.open(tmp, 'w', 0o600) { |f| f.write(content) }
      File.rename(tmp, path)
    end
  end

  def self.sink
    @sink ||= Sink.new(ENV.fetch('MONITOR_OUTBOX', '/data/monitor-outbox'),
      max_bytes: Integer(ENV.fetch('MONITOR_OUTBOX_MAX_BYTES', '268435456')))
  end

  def self.open(request, transport)
    return nil unless ENV['MONITOR_ENABLED'] == 'true'
    path = request[:path].to_s
    return nil unless path.match?(%r{/(responses|chat/completions)(?:\?|$|/)})
    user = request[:proxy_username].to_s
    allowed = ENV.fetch('MONITOR_USERS', '').split(',').map(&:strip)
    return nil if user.empty? || (!allowed.include?('*') && !allowed.include?(user))
    if transport == 'websocket'
      WebSocketCapture.new(sink, user, request[:headers] || {})
    else
      Capture.new(sink, user, request[:headers] || {}, transport, request[:body], request[:method])
    end
  rescue StandardError
    nil
  end

  class WebSocketCapture
    def initialize(sink, user, headers)
      @sink, @user, @headers = sink, user, headers
      @pending, @responses, @items, @all = [], {}, {}, []
    end

    def client(payload)
      value = JSON.parse(payload.to_s)
      return unless value['type'] == 'response.create' || value.key?('input')
      return if @pending.length >= 32
      capture = Capture.new(@sink, @user, @headers, 'websocket', payload)
      @pending << capture
      @all << capture
      prune
    rescue StandardError
      nil
    end

    def server(payload)
      value = JSON.parse(payload.to_s)
      # Rate-limit/connection notifications are not model responses and must not
      # consume the next pending request or create an empty phantom session.
      return unless value['type'].to_s.start_with?('response.') || value['type'] == 'error'
      response_id = value.dig('response', 'id') || value['response_id']
      capture = response_id && @responses[response_id]
      if value['type'] == 'response.created' && !capture
        capture = @pending.shift
        @responses[response_id] = capture if capture && response_id
      end
      capture ||= @items[value['item_id']]
      capture ||= @responses.values.reject(&:terminal?).uniq.then { |active| active.length == 1 ? active.first : nil }
      capture ||= @pending.first if @pending.length == 1
      unless capture
        capture = Capture.new(@sink, @user, @headers, 'websocket')
        @all << capture
      end
      @responses[response_id] = capture if response_id
      @pending.delete(capture) if response_id
      item_id = value.dig('item', 'id') || value['item_id']
      @items[item_id] = capture if item_id
      capture.server(value)
      @last = capture
      prune
    rescue StandardError
      nil
    end

    def retry
      return unless @last
      @last.retry
      @pending << @last
    rescue StandardError
      nil
    end

    def gap(reason)
      @last&.emit('delivery.gap', { reason: reason })
    rescue StandardError
      nil
    end

    def prune
      while @all.length > 128
        old = @all.find(&:terminal?)
        break unless old
        old.close
        @all.delete(old)
        @responses.delete_if { |_, c| c.equal?(old) }
        @items.delete_if { |_, c| c.equal?(old) }
      end
    end

    def close
      @all.each(&:close)
    rescue StandardError
      nil
    end
  end

  class Capture
    def terminal?; @terminal; end
    def initialize(sink, user, headers, transport, body = nil, method = 'POST')
      @sink, @transport, @method = sink, transport, method
      metadata = JSON.parse(headers['x-codex-turn-metadata'].to_s) rescue {}
      sid = headers['session-id'] || headers['session_id'] || metadata['session_id']
      @user_key = Digest::SHA256.hexdigest(user)[0, 24]
      @connection = SecureRandom.uuid
      @scope = { tenantId: @user_key, connectionId: 'codex-proxy',
        sessionId: Digest::SHA256.hexdigest("#{user}/#{sid || @connection}")[0, 32],
        correlation: sid.to_s.empty? ? 'unassigned' : 'explicit' }
      @buffers, @revisions, @last_flush, @item_meta = {}, Hash.new(0), {}, {}
      @sse = +''.b
      @closed, @terminal = false, false
      @current = nil
      @response_requests = {}
      @sink.emit(@scope, 'source.status', { state: 'connected', transport: transport })
      client(body) if body && !body.to_s.empty?
    end

    def emit(type, data)
      @sink.emit(@scope.merge(requestId: @current && @current[:request], attemptId: @current && @current[:attempt]), type, data)
    end

    def start(value = {}, retrying: false)
      finish('incomplete') if @current && !@terminal
      previous = @current
      @current = { request: retrying && previous ? previous[:request] : SecureRandom.uuid,
        attempt: SecureRandom.uuid, started: Time.now.to_f, response: nil }
      @terminal = false
      @model = value['model'] || @model
      emit('request.started', { transport: @transport, method: @method, model: @model,
        retry: retrying, status: 'streaming', responseId: nil })
    end

    def client(payload)
      value = payload.is_a?(Hash) ? JSON.parse(JSON.generate(payload)) : JSON.parse(payload.to_s)
      return unless value.is_a?(Hash)
      value = value['response'] if value['response'].is_a?(Hash)
      start(value)
      inputs = value['input'] || value['messages']
      inputs = [{ 'role' => 'user', 'content' => inputs }] if inputs.is_a?(String)
      occurrences = Hash.new(0)
      Array(inputs).each do |item|
        next unless item.is_a?(Hash)
        next if %w[system developer].include?(item['role'])
        fingerprint = Digest::SHA256.hexdigest(JSON.generate(item.reject { |k, _| k == 'encrypted_content' }))
        occurrences[fingerprint] += 1
        id = item['id'] || "input-#{fingerprint[0, 24]}-#{occurrences[fingerprint]}"
        snapshot(item, id, context: true)
      end
    rescue StandardError
      emit('delivery.gap', { reason: 'unparsed_client_payload' })
    end

    def retry
      start({}, retrying: true)
    rescue StandardError
      nil
    end

    def http(status, body)
      emit('request.updated', { httpStatus: status })
      value = body.is_a?(Hash) ? body : JSON.parse(body.to_s)
      if value.is_a?(Hash)
        server(value['type'] ? value : { 'type' => 'response.completed', 'response' => value })
      end
      finish(status.to_i >= 400 ? 'failed' : 'completed') unless @terminal
    rescue StandardError
      finish(status.to_i >= 400 ? 'failed' : 'incomplete')
    end

    def feed(bytes)
      return if @unsupported_encoding
      bytes = @decoder.inflate(bytes) if @decoder
      @sse << bytes.b
      if @sse.bytesize > 4 * 1024 * 1024
        @sse.clear
        emit('delivery.gap', { reason: 'sse_event_too_large' })
        return
      end
      while (match = @sse.match(/\r?\n\r?\n/))
        frame = @sse.slice!(0, match.end(0)).force_encoding('UTF-8')
        data = frame.lines.filter_map { |line| line.sub(/\Adata: ?/, '').strip if line.start_with?('data:') }.join("\n")
        next if data.empty? || data == '[DONE]'
        server(data)
      end
    rescue StandardError
      emit('delivery.gap', { reason: 'sse_decode_error' })
    end

    def headers(headers, status = nil)
      encoding = headers.to_h.transform_keys { |k| k.to_s.downcase }['content-encoding'].to_s.downcase
      @decoder = Zlib::Inflate.new(Zlib::MAX_WBITS + 16) if encoding == 'gzip'
      @decoder = Zlib::Inflate.new if encoding == 'deflate'
      if !['', 'identity', 'gzip', 'deflate'].include?(encoding)
        @unsupported_encoding = true
        emit('delivery.gap', { reason: 'unsupported_sse_encoding', encoding: encoding })
      end
      emit('request.updated', { httpStatus: status }) if status
    rescue StandardError
      emit('delivery.gap', { reason: 'sse_headers_invalid' })
    end

    def server(payload)
      value = payload.is_a?(Hash) ? JSON.parse(JSON.generate(payload)) : JSON.parse(payload.to_s)
      return unless value.is_a?(Hash)
      start if !@current
      type = value['type'].to_s
      response = value['response'].is_a?(Hash) ? value['response'] : {}
      if type == 'response.created'
        @model = response['model'] || @model
        @current[:response] = response['id']
        emit('request.updated', { responseId: response['id'], model: @model })
      end
      if type.end_with?('.delta')
        kind = if type.include?('reasoning') then 'reasoning'
               elsif type.include?('function_call_arguments') || type.include?('custom_tool_call_input') then 'tool_call'
               elsif type.include?('output_text') then 'message' end
        if kind && value['delta'].is_a?(String)
          id = value['item_id'] || @current[:response] || @current[:attempt]
          part = value['summary_index'] || value['content_index'] || 0
          key = "#{id}:#{kind}:#{part}"
          text = (@buffers[key] ||= +'')
          remaining = MAX_ITEM - text.bytesize
          text << value['delta'].byteslice(0, [remaining, 0].max).to_s.force_encoding('UTF-8').scrub
          @item_meta[key] ||= { kind: kind, role: 'assistant', originalId: id, partIndex: part }
          @item_meta[key][:truncated] = true if value['delta'].bytesize > remaining
          flush(key, false) if Time.now.to_f - (@last_flush[key] || 0) >= 0.05
        end
      elsif type == 'response.output_item.added'
        item = value['item'] || {}
        snapshot(item, item['id'] || value['item_id'], complete: false)
      elsif type == 'response.output_item.done'
        item = value['item'] || {}
        snapshot(item, item['id'] || value['item_id'])
      elsif type.match?(/response\.(completed|failed|incomplete)$/)
        Array(response['output']).each { |item| snapshot(item, item['id']) if item.is_a?(Hash) }
        usage(response['usage']) if response['usage'].is_a?(Hash)
        error = response['error'] || value['error']
        emit('request.updated', { error: CodexMonitor.clean(error.is_a?(Hash) ? error['message'] : error), model: response['model'] || @model }) if error
        finish(type.split('.').last)
      elsif type == 'error' || value['error']
        error = value['error'] || value
        emit('request.updated', { error: CodexMonitor.clean(error['message'] || error['code']) })
        finish('failed')
      elsif value['choices'].is_a?(Array)
        # HTTP Chat Completions is supported without inventing Responses IDs.
        value['choices'].each_with_index do |choice, i|
          message = choice['message'] || choice['delta'] || {}
          snapshot(message.merge('type' => 'message'), "#{@current[:attempt]}-choice-#{i}") if message['content']
        end
        usage(value['usage']) if value['usage'].is_a?(Hash)
      end
    rescue StandardError
      emit('delivery.gap', { reason: 'unparsed_server_event' })
    end

    def text_content(value)
      case value
      when String then value
      when Array then value.filter_map { |v| text_content(v) }.join("\n")
      when Hash then value['text'] || value['output_text'] || (value['content'] && text_content(value['content']))
      end.to_s
    end

    def snapshot(item, id, context: false, complete: true)
      return unless item.is_a?(Hash) && id
      type = item['type'].to_s
      role = item['role'] || 'assistant'
      return if %w[system developer].include?(role)
      if type == 'reasoning'
        Array(item['summary']).each_with_index do |part, i|
          set_text("#{id}:reasoning:#{i}", text_content(part), { kind: 'reasoning', role: role, originalId: id, partIndex: i, context: context }, complete)
        end
        return
      end
      kind = if type.match?(/(?:function|custom_tool)_call_output/) || role == 'tool' then 'tool_result'
             elsif type.match?(/(?:function|custom_tool)_call/) then 'tool_call'
             else 'message' end
      value = kind == 'tool_call' ? (item['arguments'] || item['input']) : (item['output'] || item['content'] || item['text'])
      text = value.is_a?(Hash) ? JSON.generate(value) : text_content(value)
      return if text.empty? && kind == 'message'
      key = "#{id}:#{kind}:0"
      metadata = { kind: kind, role: role, originalId: id, callId: item['call_id'] || item['tool_call_id'],
        name: item['name'], partIndex: 0, context: context, status: item['status'] }
      # Added tool items supply a name before argument deltas arrive.
      @item_meta[key] = (@item_meta[key] || {}).merge(metadata.compact)
      set_text(key, text, @item_meta[key], complete) unless text.empty? && !complete
    end

    def set_text(key, text, meta, complete)
      return if text.empty? && @buffers[key] && !@buffers[key].empty?
      @buffers[key] = text.byteslice(0, MAX_ITEM).to_s.force_encoding('UTF-8').scrub
      @item_meta[key] = meta.merge(truncated: text.bytesize > MAX_ITEM)
      flush(key, complete)
    end

    def flush(key, complete)
      raw = @buffers[key].to_s
      # Never publish an unfinished lexical token. A split credential stays buffered
      # until it can be classified; keep the preceding assignment context as well.
      visible = if complete then raw
                elsif raw.length > 160
                  prefix = raw[0...-160]
                  prefix.sub(/\S*\z/, '')
                else '' end
      clean = CodexMonitor.clean(visible)
      return if clean.empty? && !complete
      @revisions[key] += 1
      parts = clean.scan(/.{1,12000}/m)
      parts = [''] if parts.empty?
      parts.each_with_index do |part, i|
        emit('item.snapshot', { **@item_meta.fetch(key, {}), itemId: "#{key}/#{i}", groupId: key,
          segment: i, segments: parts.length, text: part, revision: @revisions[key], complete: complete })
      end
      @last_flush[key] = Time.now.to_f
    end

    def usage(value)
      input = value['input_tokens'] || value['prompt_tokens']
      output = value['output_tokens'] || value['completion_tokens']
      emit('usage.snapshot', { input: input, output: output, total: value['total_tokens'],
        cached: value.dig('input_tokens_details', 'cached_tokens') || value.dig('prompt_tokens_details', 'cached_tokens'),
        reasoning: value.dig('output_tokens_details', 'reasoning_tokens') || value.dig('completion_tokens_details', 'reasoning_tokens'),
        responseId: @current[:response], revision: 1 })
    end

    def finish(status)
      return unless @current && !@terminal
      @buffers.keys.each { |key| flush(key, true) }
      emit('request.updated', { status: status, durationMs: ((Time.now.to_f - @current[:started]) * 1000).round,
        responseId: @current[:response], model: @model })
      @terminal = true
      @buffers.clear
      @item_meta.clear
    end

    def close
      return if @closed
      emit('delivery.gap', { reason: 'truncated_sse_frame' }) unless @sse.empty?
      finish('incomplete') unless @terminal
      @sink.emit(@scope, 'source.status', { state: 'quiet', transport: @transport })
      @closed = true
      @decoder&.close
    rescue StandardError
      nil
    end
  end
end
