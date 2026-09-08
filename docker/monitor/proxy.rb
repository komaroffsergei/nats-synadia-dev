#!/usr/bin/env ruby
# RubyMITM - HTTPS MITM proxy for capturing Codex HTTP traffic.

require 'base64'
require 'faraday'
require 'async/queue'
require 'async/semaphore'
require 'async/http/faraday'
require 'async/http/client'
require 'async/http/internet'
require 'async/http/proxy'
require 'json'
require 'kernel/sync'
require 'io/wait'
require 'open3'
require 'openssl'
require 'rack/utils'
require 'securerandom'
require 'socket'
require 'stringio'
require 'thread'
require 'time'
require 'uri'
require 'zlib'
require_relative '../asset_store'
require_relative '../upstream_proxy'
require_relative '../monitor/observer'

module RubyMITM
  CAPTURES = []
  CAPTURE_MUTEX = Mutex.new
  CERTS = {}
  CERT_MUTEX = Mutex.new

  MAX_HEADER_BYTES = 128 * 1024
  MAX_LOG_BODY_BYTES = Integer(ENV.fetch('MAX_LOG_BODY_BYTES', '0'))
  MAX_CAPTURE_BODY_BYTES = Integer(ENV.fetch('MAX_CAPTURE_BODY_BYTES', '32768'))
  MAX_CAPTURES = Integer(ENV.fetch('MAX_CAPTURES', '500'))
  SSE_CHUNK_LOG_INTERVAL = Integer(ENV.fetch('SSE_CHUNK_LOG_INTERVAL', '0'))
  USAGE_LIMIT_RETRY_ATTEMPTS = Integer(ENV.fetch('USAGE_LIMIT_RETRY_ATTEMPTS', '1'))
  USAGE_LIMIT_MARKERS = [
    "you've hit your usage limit",
    'you have hit your usage limit',
    'purchase more credits',
    'chatgpt.com/codex/settings/usage'
  ].freeze
  CYBER_POLICY_ERROR_CODES = %w[
    cyber_policy
  ].freeze
  CYBER_POLICY_SESSION_FLAGS = %w[
    high_risk_cyber_activity
  ].freeze
  CYBER_POLICY_VERIFICATION_RECOMMENDATIONS = %w[
    trusted_access_for_cyber
  ].freeze
  FAILED_REQUEST_CLIENT_MESSAGES = Integer(ENV.fetch('FAILED_REQUEST_CLIENT_MESSAGES', '8'))
  FAILED_REQUEST_MESSAGE_BYTES = Integer(ENV.fetch('FAILED_REQUEST_MESSAGE_BYTES', '4096'))
  ZSTD_COMMAND = ENV.fetch('ZSTD_COMMAND', 'zstd')
  CLIENT_READ_TIMEOUT = Integer(ENV.fetch('CLIENT_READ_TIMEOUT', '30'))
  UPSTREAM_HEADER_TIMEOUT = Integer(ENV.fetch('UPSTREAM_HEADER_TIMEOUT', ENV.fetch('UPSTREAM_TIMEOUT', '300')))
  UPSTREAM_CONNECT_TIMEOUT = Float(ENV.fetch('UPSTREAM_CONNECT_TIMEOUT', '10'))
  UPSTREAM_TLS_TIMEOUT = Float(ENV.fetch('UPSTREAM_TLS_TIMEOUT', '10'))
  UPSTREAM_WRITE_TIMEOUT = Float(ENV.fetch('UPSTREAM_WRITE_TIMEOUT', '10'))
  WEBSOCKET_UPGRADE_TIMEOUT = Float(ENV.fetch('WEBSOCKET_UPGRADE_TIMEOUT', '20'))
  WEBSOCKET_TRACE_MAX_MESSAGES = Integer(ENV.fetch('WEBSOCKET_TRACE_MAX_MESSAGES', '256'))
  WEBSOCKET_TRACE_MAX_BYTES = Integer(ENV.fetch('WEBSOCKET_TRACE_MAX_BYTES', '4194304'))
  WEBSOCKET_TRACE_MESSAGE_BYTES = Integer(ENV.fetch('WEBSOCKET_TRACE_MESSAGE_BYTES', '65536'))
  WEBSOCKET_INSPECTION_MAX_BYTES = Integer(ENV.fetch('WEBSOCKET_INSPECTION_MAX_BYTES', '16777216'))
  WEBSOCKET_REPLAY_MAX_BYTES = Integer(ENV.fetch('WEBSOCKET_REPLAY_MAX_BYTES', '8388608'))
  WEBSOCKET_FRAME_MAX_BYTES = Integer(ENV.fetch('WEBSOCKET_FRAME_MAX_BYTES', '33554432'))
  STREAM_CAPTURE_MAX_BYTES = Integer(ENV.fetch('STREAM_CAPTURE_MAX_BYTES', '8388608'))
  WEBSOCKET_INFLATE_CHUNK_BYTES = 1024
  EMFILE_BACKOFF_SECONDS = Float(ENV.fetch('EMFILE_BACKOFF_SECONDS', '1'))
  PROXY_MAX_CONNECTIONS = Integer(ENV.fetch('PROXY_MAX_CONNECTIONS', '1024'))
  RELAY_STOP_TIMEOUT = Float(ENV.fetch('RELAY_STOP_TIMEOUT', '2'))
  SERVER_STOP_TIMEOUT = Float(ENV.fetch('SERVER_STOP_TIMEOUT', '5'))
  READ_CHUNK = 16 * 1024
  DEFAULT_PORT = 8080
  CODEX_API_KEY_BRIDGE_AUTHORIZATION = 'Bearer 0000'.freeze
  CODEX_API_KEY_BRIDGE_SOURCE_HOST = 'api.openai.com'.freeze
  CODEX_API_KEY_BRIDGE_SOURCE_PATH = '/v1/responses'.freeze
  CODEX_API_KEY_BRIDGE_UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/responses'.freeze
  CODEX_API_KEY_BRIDGE_EXPIRY_SKEW_SECONDS = 30
  CODEX_API_KEY_BRIDGE_UNAVAILABLE_BODY = "Service Unavailable\n".freeze
  CODEX_API_KEY_BRIDGE_STRIPPED_HEADERS = %w[
    authorization
    chatgpt-account-id
    cookie
    openai-organization
    openai-project
  ].freeze
  CODEX_INTERCEPT_HOSTS = %w[
    api.openai.com
    chatgpt.com
  ].freeze

  raise ArgumentError, 'PROXY_MAX_CONNECTIONS must be positive' unless PROXY_MAX_CONNECTIONS.positive?
  raise ArgumentError, 'RELAY_STOP_TIMEOUT must be positive' unless RELAY_STOP_TIMEOUT.positive?
  raise ArgumentError, 'SERVER_STOP_TIMEOUT must be positive' unless SERVER_STOP_TIMEOUT.positive?
  {
    'UPSTREAM_CONNECT_TIMEOUT' => UPSTREAM_CONNECT_TIMEOUT,
    'UPSTREAM_TLS_TIMEOUT' => UPSTREAM_TLS_TIMEOUT,
    'UPSTREAM_WRITE_TIMEOUT' => UPSTREAM_WRITE_TIMEOUT,
    'WEBSOCKET_UPGRADE_TIMEOUT' => WEBSOCKET_UPGRADE_TIMEOUT,
    'WEBSOCKET_TRACE_MAX_MESSAGES' => WEBSOCKET_TRACE_MAX_MESSAGES,
    'WEBSOCKET_TRACE_MAX_BYTES' => WEBSOCKET_TRACE_MAX_BYTES,
    'WEBSOCKET_TRACE_MESSAGE_BYTES' => WEBSOCKET_TRACE_MESSAGE_BYTES,
    'WEBSOCKET_INSPECTION_MAX_BYTES' => WEBSOCKET_INSPECTION_MAX_BYTES,
    'WEBSOCKET_REPLAY_MAX_BYTES' => WEBSOCKET_REPLAY_MAX_BYTES,
    'WEBSOCKET_FRAME_MAX_BYTES' => WEBSOCKET_FRAME_MAX_BYTES,
    'STREAM_CAPTURE_MAX_BYTES' => STREAM_CAPTURE_MAX_BYTES
  }.each do |name, value|
    raise ArgumentError, "#{name} must be positive" unless value.positive?
  end

  class UpstreamTimeout < IOError
    attr_reader :phase

    def initialize(phase)
      @phase = phase.to_s
      super("#{@phase} timed out")
    end
  end

  class WebSocketInspectionLimit < StandardError
    attr_reader :body_bytes

    def initialize(body_bytes)
      @body_bytes = body_bytes
      super("WebSocket message inspection exceeded #{WEBSOCKET_INSPECTION_MAX_BYTES} bytes")
    end
  end

  class RawAsyncInternet < Async::HTTP::Internet
    protected

    def make_client(endpoint)
      Async::HTTP::Client.new(endpoint, **@options)
    end
  end

  class Server
    def initialize(host: '0.0.0.0', port: ENV.fetch('PORT', DEFAULT_PORT).to_i, auth_store: AssetStore.new)
      @host = host
      @port = port
      @auth_store = auth_store
      @started_at = nil
      @last_error = nil
      @running = false
      @stopping = false
      @server = nil
      @stop_reader = nil
      @stop_writer = nil
      @accept_task = nil
      @stop_task = nil
      @runtime_task = nil
      @connection_semaphore = nil
      @connection_tasks = {}
      @metrics_mutex = Mutex.new
      @active_connection_count = 0
      @rejected_connection_count = 0
      @active_opaque_relay_count = 0
      @active_websocket_relay_count = 0
      @forced_relay_cleanup_count = 0
      @forced_websocket_relay_cleanup_count = 0
      @upstream_timeout_count = 0
      @upstream_timeouts_by_phase = Hash.new(0)
      @last_upstream_timeout_at = nil
      @last_upstream_timeout_phase = nil
      @ca_cert = OpenSSL::X509::Certificate.new(File.read(ca_cert_path))
      @ca_key = OpenSSL::PKey.read(File.read(ca_key_path))
    end

    attr_reader :host, :port, :started_at, :last_error

    def self.start_async(**args)
      server = new(**args)
      thread = Thread.new do
        Sync do |task|
          server.run(parent: task)
        end
      rescue => e
        server.instance_variable_set(:@last_error, "#{e.class}: #{e.message}")
      end
      thread.abort_on_exception = false
      thread.name = 'ruby-mitm-async-reactor'
      server.instance_variable_set(:@thread, thread)
      server
    end

    def running? = @running && (@thread.nil? || @thread.alive?)

    def stop(timeout: SERVER_STOP_TIMEOUT)
      @stopping = true
      signal_stop

      thread = @thread
      if thread&.alive? && thread != Thread.current && !thread.join(timeout)
        @last_error = "Async reactor did not stop within #{timeout}s; forcing termination"
        log @last_error
        thread.kill
        thread.join(1)
      end
      @running = false
    end

    def status_payload
      {
        running: running?,
        host: @host,
        port: @port,
        started_at: @started_at&.iso8601,
        last_error: @last_error,
        auth_required: auth_required?,
        process: process_metrics,
        captures: stats_payload
      }
    end

    def run(parent: Async::Task.current?)
      return Sync { |task| run(parent: task) } unless parent

      promote_open_file_limit
      log "Starting RubyMITM on http://#{@host}:#{@port}"
      log "CA cert: #{ca_cert_path}"
      @runtime_task = parent
      @connection_semaphore = Async::Semaphore.new(PROXY_MAX_CONNECTIONS, parent: parent)
      @stop_reader, @stop_writer = IO.pipe
      @server = TCPServer.new(@host, @port)
      @running = true
      @started_at = Time.now

      @accept_task = parent.async(annotation: 'RubyMITM accept loop') do
        accept_loop(parent)
      end
      @stop_task = parent.async(annotation: 'RubyMITM stop signal') do
        @stop_reader.read(1)
        @accept_task.cancel unless @accept_task.finished?
      end
      @accept_task.wait
    rescue Interrupt
      log 'Shutting down'
    rescue IOError
      log 'Shutting down'
    rescue => e
      @last_error = "#{e.class}: #{e.message}"
      log "Server error: #{@last_error}"
      raise
    ensure
      @running = false
      @accept_task&.cancel unless @accept_task&.finished?
      @stop_task&.cancel unless @stop_task&.finished?
      @server&.close
      cancel_connection_tasks
      @stop_reader&.close rescue nil
      @stop_writer&.close rescue nil
      @server = nil
      @stop_reader = nil
      @stop_writer = nil
      @accept_task = nil
      @stop_task = nil
      @connection_semaphore = nil
      @runtime_task = nil
    end

    private

    def accept_loop(parent)
      until @stopping
        socket = accept_client
        next unless socket

        if @connection_semaphore.blocking?
          reject_excess_connection(socket)
          next
        end

        @connection_semaphore.async(socket, parent: parent, annotation: 'RubyMITM client') do |task, client|
          @connection_tasks[task.object_id] = task
          track_active_connection { handle_client(client) }
        ensure
          @connection_tasks.delete(task.object_id)
          client.close rescue nil
        end
      end
    end

    def signal_stop
      @stop_writer&.write_nonblock('.')
    rescue IOError, SystemCallError
      nil
    end

    def accept_client
      @server.accept
    rescue Errno::EMFILE, Errno::ENFILE => e
      @last_error = "#{e.class}: #{e.message}"
      log "Accept temporarily failed: #{@last_error}; retrying in #{EMFILE_BACKOFF_SECONDS}s"
      sleep EMFILE_BACKOFF_SECONDS
      nil
    end

    def promote_open_file_limit
      soft, hard = Process.getrlimit(Process::RLIMIT_NOFILE)
      target = ENV.fetch('OPEN_FILE_LIMIT', hard.to_s).to_i
      target = hard if target <= 0
      target = [target, hard].min
      return if soft >= target

      Process.setrlimit(Process::RLIMIT_NOFILE, target, hard)
      log "Open file limit raised from #{soft} to #{target}"
    rescue NotImplementedError, ArgumentError, SystemCallError => e
      @last_error = "#{e.class}: #{e.message}"
      log "Open file limit unchanged: #{@last_error}"
    end

    def process_metrics
      soft, hard = Process.getrlimit(Process::RLIMIT_NOFILE)
      fd_count = Dir.children('/proc/self/fd').size if Dir.exist?('/proc/self/fd')
      {
        fd_count: fd_count,
        fd_limit_soft: soft,
        fd_limit_hard: hard,
        thread_count: Thread.list.count,
        async_runtime: !@runtime_task.nil?,
        **connection_metrics
      }.compact
    rescue NotImplementedError, SystemCallError
      { thread_count: Thread.list.count, async_runtime: !@runtime_task.nil?, **connection_metrics }
    end

    def connection_metrics
      @metrics_mutex.synchronize do
        {
          active_connection_count: @active_connection_count,
          connection_limit: PROXY_MAX_CONNECTIONS,
          rejected_connection_count: @rejected_connection_count,
          active_opaque_relay_count: @active_opaque_relay_count,
          active_websocket_relay_count: @active_websocket_relay_count,
          forced_relay_cleanup_count: @forced_relay_cleanup_count,
          forced_websocket_relay_cleanup_count: @forced_websocket_relay_cleanup_count,
          upstream_timeout_count: @upstream_timeout_count,
          upstream_timeouts_by_phase: @upstream_timeouts_by_phase.dup,
          last_upstream_timeout_at: @last_upstream_timeout_at&.iso8601,
          last_upstream_timeout_phase: @last_upstream_timeout_phase
        }
      end
    end

    def track_active_connection
      @metrics_mutex.synchronize { @active_connection_count += 1 }
      yield
    ensure
      @metrics_mutex.synchronize { @active_connection_count -= 1 }
    end

    def reject_excess_connection(socket)
      @metrics_mutex.synchronize { @rejected_connection_count += 1 }
      socket.close
    rescue IOError, SystemCallError
      nil
    end

    def track_active_opaque_relay
      @metrics_mutex.synchronize { @active_opaque_relay_count += 1 }
      yield
    ensure
      @metrics_mutex.synchronize { @active_opaque_relay_count -= 1 }
    end

    def track_active_websocket_relay
      @metrics_mutex.synchronize { @active_websocket_relay_count += 1 }
      yield
    ensure
      @metrics_mutex.synchronize { @active_websocket_relay_count -= 1 }
    end

    def cancel_connection_tasks
      tasks = @connection_tasks.values
      tasks.each { |task| task.cancel unless task.finished? }
      tasks.each(&:wait)
    ensure
      @connection_tasks.clear
    end

    def ca_cert_path = File.expand_path(ENV.fetch('MITM_CA_CERT', '~/.mitmproxy/mitmproxy-ca-cert.pem'))

    def ca_key_path = File.expand_path(ENV.fetch('MITM_CA_KEY', '~/.mitmproxy/mitmproxy-ca.pem'))

    def handle_client(socket)
      request = read_http_request(socket)
      return socket.close unless request

      method, target, _version = request[:request_line].split(' ', 3)
      intercept = method == 'CONNECT' && codex_interception_required?(target)
      username = authenticated_username(request, touch: !method.eql?('CONNECT') || intercept)
      unless username
        write_proxy_auth_required(socket)
        return
      end
      request[:proxy_username] = username

      case method
      when 'CONNECT'
        if intercept
          handle_connect(socket, target, username)
        else
          handle_passthrough_connect(socket, target)
        end
      when 'GET', 'POST'
        handle_control_request(socket, target, request, username)
      else
        write_plain_response(socket, 405, 'Method Not Allowed', "Unsupported method: #{method}\n")
      end
    rescue => e
      log "Client error: #{e.class}: #{e.message}"
      socket.close rescue nil
    end

    def handle_passthrough_connect(socket, target)
      host, port = parse_authority(target)
      upstream = open_passthrough_upstream(host, port)
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      socket.flush
      relay_bidirectional(socket, upstream)
    rescue
      nil
    ensure
      upstream&.close rescue nil
      socket.close rescue nil
    end

    def open_passthrough_upstream(host, port)
      uri = URI::HTTPS.build(host: host, port: port, path: '')
      open_upstream_tcp(uri, upstream_proxy_for(uri))
    end

    def codex_interception_required?(target)
      host, port = parse_authority(target)
      port == 443 && CODEX_INTERCEPT_HOSTS.include?(host.to_s.downcase)
    end

    def handle_control_request(socket, target, request, username)
      path = URI.parse(target).path rescue target

      if request[:method] == 'POST' && path =~ %r{\A/api/sessions/([^/]+)/events\z}
        handle_session_events_api(socket, Regexp.last_match(1), request, username)
        return
      end

      unless request[:method] == 'GET'
        write_plain_response(socket, 405, 'Method Not Allowed', "Unsupported method: #{request[:method]}\n")
        return
      end

      case path
      when '/', ''
        write_plain_response(socket, 200, 'OK', "RubyMITM - use /stats and /ca.pem\n")
      when '/stats'
        write_json_response(socket, status_payload)
      when '/report'
        write_plain_response(socket, 404, 'Not Found', "Not Found\n")
      when '/ca.pem'
        body = File.read(ca_cert_path)
        write_response(socket, 200, 'OK', { 'Content-Type' => 'application/x-pem-file' }, body)
      else
        write_plain_response(socket, 404, 'Not Found', "Not Found\n")
      end
    ensure
      socket.close rescue nil
    end

    def handle_session_events_api(socket, encoded_session_id, request, username)
      session_id = URI.decode_www_form_component(encoded_session_id)
      payload = JSON.parse(request[:body].to_s)
      events = payload['events'].is_a?(Array) ? payload['events'] : [payload]
      imported = events.map do |event|
        @auth_store.record_session_event(username: username, session_id: session_id, event: event)
      end

      write_json_response(socket, status: 'ok', imported: imported.map { |item| item.slice(:request_id, :event) })
    rescue JSON::ParserError => e
      write_response(socket, 400, 'Bad Request', { 'Content-Type' => 'application/json' }, JSON.generate(status: 'error', error: "Invalid JSON: #{e.message}"))
    rescue ArgumentError => e
      write_response(socket, 422, 'Unprocessable Content', { 'Content-Type' => 'application/json' }, JSON.generate(status: 'error', error: e.message))
    end

    def handle_connect(socket, target, username = nil)
      host, port = parse_authority(target)
      log "CONNECT #{host}:#{port}"

      socket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: RubyMITM\r\n\r\n")
      socket.flush

      scheme = port == 443 ? 'https' : 'http'
      io = socket

      if scheme == 'https'
        ssl = OpenSSL::SSL::SSLSocket.new(socket, ssl_context_for(host))
        ssl.sync_close = true
        accept_tls_with_timeout(ssl)
        io = ssl
      end

      loop do
        request = read_http_request(io)
        break unless request
        request[:proxy_username] = username
        request[:connect_authority] = target

        if websocket_request?(request)
          forward_websocket_request(request, io, host, port, scheme)
          break
        elsif sse_request?(request)
          forward_streaming_intercepted_request(request, io, host, port, scheme)
          break
        else
          response = forward_intercepted_request(request, host, port, scheme)
          write_upstream_response(io, response)
          break unless keep_alive?(request, response)
        end
      end
    rescue OpenSSL::SSL::SSLError => e
      log "TLS error for #{target}: #{e.message}"
    rescue => e
      log "CONNECT error for #{target}: #{e.class}: #{e.message}"
    ensure
      ssl&.close rescue nil
      socket.close rescue nil
    end

    def forward_websocket_request(request, io, fallback_host, fallback_port, scheme)
      method = request[:method]
      path = request[:path]
      headers = request[:headers]
      body = request[:body]
      authority = headers['host'] || default_authority(fallback_host, fallback_port, scheme)
      client_url = absolute_url(scheme, authority, path)
      bridge_requested = codex_api_key_bridge_request?(request, fallback_host, fallback_port, scheme)
      bridge_plan = build_codex_api_key_bridge_plan if bridge_requested
      started_at = Time.now
      trace_enabled = trace_enabled_for_user?(request[:proxy_username])
      session_id = trace_session_id(request) if trace_enabled

      log "  #{method} #{client_url} (websocket)"
      log_headers('  request headers', headers)
      unless !bridge_requested || bridge_plan
        log '  Codex API-key bridge unavailable'
        write_upstream_response(io, codex_api_key_bridge_unavailable_response)
        return
      end

      upstream_url = bridge_plan ? bridge_plan.fetch(:upstream_url) : client_url
      log "  bridge upstream #{upstream_url}" if bridge_plan
      config_id = bridge_plan ? bridge_plan.fetch(:config_id) : active_config_id
      request[:active_config_id] = config_id
      upgrade_started_at = monotonic_time
      deadline = upgrade_started_at + WEBSOCKET_UPGRADE_TIMEOUT
      upstream = open_upstream_io(upstream_url, deadline: deadline)
      write_raw_upstream_request(upstream, request, url: upstream_url, bridge_plan: bridge_plan, deadline: deadline)

      response_head = read_response_head(upstream, deadline: deadline, phase: :websocket_response_header)
      status, reason, response_headers = parse_response_head(response_head)
      log_headers('  response headers', response_headers)
      io.write(response_head)
      io.flush
      response_body = relay_websocket_rejection_body(upstream, io, response_head, response_headers, status) unless status == 101

      elapsed = Time.now - started_at
      log "  WS <- #{status} #{reason} #{format('%.3f', elapsed)}s"
      capture_request(
        method: method,
        url: client_url,
        status: status,
        elapsed: elapsed,
        request_headers: headers,
        request_body: body,
        response_headers: response_headers,
        response_body: response_body
      )

      if status == 101
        log "  WS tunnel open #{client_url}"
        websocket_messages = relay_websocket(
          request[:proxy_username],
          io,
          upstream,
          request: request,
          url: client_url,
          bridge_plan: bridge_plan,
          trace_enabled: trace_enabled
        )
        config_id = request[:active_config_id]
        log "  WS tunnel closed #{client_url}"
      end
      record_session_trace(
        username: request[:proxy_username],
        session_id: session_id,
        enabled: trace_enabled
      ) do
        trace_payload(
          transport: 'websocket',
          method: method,
          url: client_url,
          status: status,
          reason: reason,
          elapsed: Time.now - started_at,
          started_at: started_at,
          config_id: config_id,
          request_headers: headers,
          request_body: body,
          response_headers: response_headers,
          response_body: response_body,
          websocket_messages: websocket_messages
        )
      end
    rescue UpstreamTimeout => e
      elapsed = monotonic_time - upgrade_started_at
      log "  websocket upgrade timeout phase=#{e.phase} elapsed=#{format('%.3f', elapsed)}s route=#{bridge_plan ? 'bridge' : 'direct'}"
      response = websocket_gateway_timeout_response
      write_upstream_response(io, response)
      capture_request(
        method: method,
        url: client_url,
        status: response.fetch(:status),
        elapsed: elapsed,
        request_headers: headers,
        request_body: body,
        response_headers: response.fetch(:headers),
        response_body: response.fetch(:body)
      )
      record_session_trace(
        username: request[:proxy_username],
        session_id: session_id,
        enabled: trace_enabled
      ) do
        trace_payload(
          transport: 'websocket',
          method: method,
          url: client_url,
          status: response.fetch(:status),
          reason: response.fetch(:reason),
          elapsed: elapsed,
          started_at: started_at,
          config_id: config_id,
          request_headers: headers,
          request_body: body,
          response_headers: response.fetch(:headers),
          response_body: response.fetch(:body)
        )
      end
    ensure
      upstream&.close rescue nil
    end

    def forward_intercepted_request(request, fallback_host, fallback_port = 443, scheme = 'https')
      monitor = CodexMonitor.open(request, 'http')
      method = request[:method]
      path = request[:path]
      headers = request[:headers]
      body = request[:body]
      authority = headers['host'] || default_authority(fallback_host, fallback_port, scheme)
      client_url = absolute_url(scheme, authority, path)
      bridge_requested = codex_api_key_bridge_request?(request, fallback_host, fallback_port, scheme)
      bridge_plan = build_codex_api_key_bridge_plan if bridge_requested
      started_at = Time.now
      trace_enabled = trace_enabled_for_user?(request[:proxy_username])
      session_id = trace_session_id(request) if trace_enabled

      log "  #{method} #{client_url}"
      log_headers('  request headers', headers)
      if bridge_requested && !bridge_plan
        unavailable = codex_api_key_bridge_unavailable_response
        status = unavailable.fetch(:status)
        reason = unavailable.fetch(:reason)
        response_headers = unavailable.fetch(:headers)
        response_body = unavailable.fetch(:body)
        config_id = nil
      else
        upstream_url = bridge_plan ? bridge_plan.fetch(:upstream_url) : client_url
        log "  bridge upstream #{upstream_url}" if bridge_plan
        config_id = bridge_plan ? bridge_plan.fetch(:config_id) : active_config_id
        monitor&.source_config(config_id)
        status, reason, response_headers, response_body = forward_request(
          method,
          upstream_url,
          headers,
          body,
          bridge_plan: bridge_plan
        )
        status, reason, response_headers, response_body, config_id = retry_limited_response(
          method,
          client_url,
          headers,
          body,
          status,
          reason,
          response_headers,
          response_body,
          config_id,
          monitor: monitor,
          bridge_plan: bridge_plan
        )
      end
      elapsed = Time.now - started_at
      log "  <- #{status} #{response_body.bytesize}b #{format('%.3f', elapsed)}s"
      log_headers('  response headers', response_headers)

      capture_request(
        method: method,
        url: client_url,
        status: status,
        elapsed: elapsed,
        request_headers: headers,
        request_body: body,
        response_headers: response_headers,
        response_body: response_body
      )
      record_session_trace(
        username: request[:proxy_username],
        session_id: session_id,
        enabled: trace_enabled
      ) do
        trace_payload(
          transport: 'http',
          method: method,
          url: client_url,
          status: status,
          reason: reason,
          elapsed: elapsed,
          started_at: started_at,
          config_id: config_id,
          request_headers: headers,
          request_body: body,
          response_headers: response_headers,
          response_body: response_body
        )
      end
      if cyber_policy_response?(response_body)
        record_cyber_policy_response_sample(
          response_body,
          from_id: config_id,
          sample: {
            transport: 'http',
            method: method,
            url: client_url,
            status: status,
            reason: reason,
            request_headers: headers,
            request_body: body,
            response_headers: response_headers
          }
        )
      elsif failed_response_payload?(response_body) && !usage_limit_response?(status, response_body, url: client_url)
        record_failed_response_sample(
          response_body,
          from_id: config_id,
          sample: {
            transport: 'http',
            method: method,
            url: client_url,
            status: status,
            reason: reason,
            request_headers: headers,
            request_body: body,
            response_headers: response_headers
          }
        )
      end
      monitor&.http(status, response_body)
      record_token_usage(request[:proxy_username], response_body, config_id: config_id)

      {
        status: status,
        reason: reason,
        headers: response_headers,
        body: response_body
      }
    ensure
      monitor&.close
    end

    def forward_request(method, url, headers, body, bridge_plan: nil)
      uri = URI.parse(url)
      options = { url: "#{uri.scheme}://#{uri.host}:#{uri.port}" }
      proxy_uri = upstream_proxy_for(uri)
      options[:proxy] = proxy_uri.to_s if proxy_uri
      conn = Faraday.new(**options) do |f|
        f.options.timeout = Integer(ENV.fetch('UPSTREAM_TIMEOUT', '300'))
        f.options.open_timeout = UPSTREAM_CONNECT_TIMEOUT
        # The connection is request-scoped. Do not create a per-thread persistent
        # cache (and a new permanent thread-local key) for every single request.
        f.adapter :async_http, clients: Async::HTTP::Faraday::Clients
      end

      upstream_headers = sanitize_upstream_headers(headers, url: url, bridge_plan: bridge_plan)
      response = conn.run_request(method.downcase.to_sym, request_uri(uri), body, upstream_headers)
      response_body = normalize_response_body(response.body.to_s, response.headers)
      response_headers = normalize_response_headers(response.headers)

      [response.status, response.reason_phrase || 'OK', response_headers, response_body]
    rescue Faraday::ConnectionFailed => e
      status = e.message.include?('end of file') ? 499 : 502
      reason = status == 499 ? 'Client Closed Request' : 'Bad Gateway'
      log "  upstream closed: #{e.message}"
      [status, reason, { 'Content-Type' => 'text/plain' }, "#{reason}: #{e.message}\n"]
    rescue => e
      log "  upstream error: #{e.class}: #{e.message}"
      [502, 'Bad Gateway', { 'Content-Type' => 'text/plain' }, "Bad Gateway: #{e.message}\n"]
    ensure
      # Each request creates its own async adapter and persistent connection pool.
      # Closing the response alone does not release that pool or its reactor tasks.
      conn&.close
    end

    def retry_limited_response(method, url, headers, body, status, reason, response_headers, response_body, config_id, bridge_plan: nil, monitor: nil)
      bridged = !bridge_plan.nil?
      attempts = 0
      while attempts < USAGE_LIMIT_RETRY_ATTEMPTS && usage_limit_response?(status, response_body, url: url)
        switch = switch_active_config_for_usage_limit(
          response_body,
          from_id: config_id,
          sample: {
            transport: 'http',
            method: method,
            url: url,
            status: status,
            reason: reason,
            request_headers: headers,
            request_body: body,
            response_headers: response_headers
          }
        )
        break unless switch

        monitor&.http(status, response_body)
        monitor&.retry
        attempts += 1
        log "  usage limit detected; switched config #{switch[:from]} -> #{switch[:to]}; retrying #{method} #{url}"
        bridge_plan = build_codex_api_key_bridge_plan if bridged
        unless !bridged || bridge_plan
          unavailable = codex_api_key_bridge_unavailable_response
          return [
            unavailable.fetch(:status),
            unavailable.fetch(:reason),
            unavailable.fetch(:headers),
            unavailable.fetch(:body),
            nil
          ]
        end

        upstream_url = bridge_plan ? bridge_plan.fetch(:upstream_url) : url
        config_id = bridge_plan ? bridge_plan.fetch(:config_id) : active_config_id
        monitor&.source_config(config_id)
        status, reason, response_headers, response_body = forward_request(
          method,
          upstream_url,
          headers,
          body,
          bridge_plan: bridge_plan
        )
      end

      [status, reason, response_headers, response_body, config_id]
    end

    def retry_websocket_after_usage_limit(state, write_lock, request, url, message, bridge_plan: nil)
      return false unless request && url
      return false unless write_lock.acquire { !state[:stopped] && state[:retries] < USAGE_LIMIT_RETRY_ATTEMPTS }

      retry_started_at = monotonic_time
      new_upstream = nil
      bridged = !bridge_plan.nil?

      switch = switch_active_config_for_usage_limit(
        message,
        from_id: request[:active_config_id],
        sample: {
          transport: 'websocket',
          method: request[:method],
          url: url,
          request_headers: request[:headers],
          client_messages: state[:client_messages].dup
        }
      )
      return false unless switch

      unless state.fetch(:replay_available, true)
        # Never replay a truncated compressed WebSocket history. The new account
        # is selected; return the upstream error so the client can reconnect safely.
        log '  websocket replay budget exceeded; account switched, client reconnect required'
        return false
      end

      log "  usage limit detected; switched config #{switch[:from]} -> #{switch[:to]}; reconnecting websocket #{url}"
      bridge_plan = build_codex_api_key_bridge_plan if bridged
      unless !bridged || bridge_plan
        log '  Codex API-key bridge unavailable after config switch'
        return false
      end

      upstream_url = bridge_plan ? bridge_plan.fetch(:upstream_url) : url
      deadline = retry_started_at + WEBSOCKET_UPGRADE_TIMEOUT
      new_upstream = open_upstream_io(upstream_url, deadline: deadline)
      write_raw_upstream_request(
        new_upstream,
        request,
        url: upstream_url,
        bridge_plan: bridge_plan,
        deadline: deadline
      )
      response_head = read_response_head(new_upstream, deadline: deadline, phase: :websocket_response_header)
      status, reason, _response_headers = parse_response_head(response_head)
      unless status == 101
        log "  websocket retry handshake failed: #{status} #{reason}"
        return false
      end

      old_upstream = nil
      write_lock.acquire do
        return false if state[:stopped] || state[:retries] >= USAGE_LIMIT_RETRY_ATTEMPTS

        state[:client_frames].each { |raw| write_websocket_frame(new_upstream, raw) }
        old_upstream = state[:upstream]
        state[:upstream] = new_upstream
        state[:retries] += 1
        request[:active_config_id] = bridge_plan ? bridge_plan.fetch(:config_id) : active_config_id
        state[:monitor]&.source_config(request[:active_config_id])
        state[:monitor]&.retry
        new_upstream = nil
      end
      old_upstream&.close rescue nil
      true
    rescue UpstreamTimeout => e
      elapsed = monotonic_time - retry_started_at
      log "  websocket retry timeout phase=#{e.phase} elapsed=#{format('%.3f', elapsed)}s"
      false
    rescue => e
      log "  websocket retry failed: #{e.class}: #{e.message}"
      false
    ensure
      new_upstream&.close rescue nil
    end

    def switch_active_config_for_usage_limit(body, from_id: nil, sample: {})
      unless @auth_store.respond_to?(:switch_active_config_for_usage_limit)
        log '  usage limit detected; auth store cannot switch configs'
        return nil
      end

      switch = @auth_store.switch_active_config_for_usage_limit(message: usage_limit_message(body), from_id: from_id)
      record_usage_limit_response_sample(body, from_id: from_id, sample: sample, switch: switch)
      log '  usage limit detected; no replacement config available' unless switch
      switch
    rescue => e
      log "  usage limit config switch failed: #{e.class}: #{e.message}"
      nil
    end

    def record_usage_limit_response_sample(body, from_id:, sample:, switch:)
      unless @auth_store.respond_to?(:record_response_sample)
        log '  usage limit detected; auth store cannot save response samples'
        return
      end

      body_value, encoded = response_sample_body(body)
      response = (sample || {}).dup
      request_headers = response.delete(:request_headers)
      request_body = response.delete(:request_body)
      response_headers = response.delete(:response_headers)
      client_messages = response.delete(:client_messages)
      path = @auth_store.record_response_sample(
        category: 'usage-limit',
        payload: {
          detected_by: 'ruby_mitm_proxy',
          detected_at: Time.now.utc.iso8601,
          config_id: from_id,
          active_config_id: active_config_id,
          switch: switch,
          request: {
            headers: sanitized_sample_headers(request_headers),
            body: request_body_sample_body(request_body),
            parsed_json: parsed_response_sample_json(request_body),
            client_messages: client_messages
          }.compact,
          response: response.merge(
            headers: sanitized_sample_headers(response_headers),
            body: body_value,
            body_base64: encoded,
            body_bytes: body.to_s.bytesize,
            parsed_json: parsed_response_sample_json(body)
          ).compact
        }.compact
      )
      log "  usage limit response sample saved: #{path}"
    rescue => e
      log "  usage limit response sample failed: #{e.class}: #{e.message}"
    end

    def record_cyber_policy_response_sample(body, from_id:, sample:)
      mark_config_cyber_policy(body, from_id: from_id)
      return unless @auth_store.respond_to?(:record_response_sample)

      body_value, encoded = response_sample_body(body)
      details = (sample || {}).dup
      request_headers = details.delete(:request_headers)
      request_body = details.delete(:request_body)
      response_headers = details.delete(:response_headers)
      client_messages = details.delete(:client_messages)
      path = @auth_store.record_response_sample(
        category: 'cyber-policy',
        payload: {
          detected_by: 'ruby_mitm_proxy',
          detected_at: Time.now.utc.iso8601,
          config_id: from_id,
          active_config_id: active_config_id,
          request: {
            headers: sanitized_sample_headers(request_headers),
            body: request_body_sample_body(request_body),
            parsed_json: parsed_response_sample_json(request_body),
            client_messages: client_messages
          }.compact,
          response: details.merge(
            headers: sanitized_sample_headers(response_headers),
            body: body_value,
            body_base64: encoded,
            body_bytes: body.to_s.bytesize,
            parsed_json: parsed_response_sample_json(body),
            structured_errors: structured_error_payloads_from_body(body),
            cyber_policy_signals: cyber_policy_payloads_from_body(body)
          ).compact
        }.compact
      )
      log "  cyber policy response sample saved: #{path}"
    rescue => e
      log "  cyber policy response sample failed: #{e.class}: #{e.message}"
    end

    def mark_config_cyber_policy(body, from_id:)
      return if from_id.to_s.empty?
      return unless @auth_store.respond_to?(:mark_config_cyber_policy)

      @auth_store.mark_config_cyber_policy(
        from_id,
        cyber_policy_message(body),
        signals: cyber_policy_signals_from_body(body)
      )
    rescue => e
      log "  cyber policy config mark failed: #{e.class}: #{e.message}"
    end

    def record_failed_response_sample(body, from_id:, sample:)
      return unless @auth_store.respond_to?(:record_response_sample)

      body_value, encoded = response_sample_body(body)
      details = (sample || {}).dup
      request_headers = details.delete(:request_headers)
      request_body = details.delete(:request_body)
      response_headers = details.delete(:response_headers)
      client_messages = details.delete(:client_messages)
      path = @auth_store.record_response_sample(
        category: 'failed-request',
        payload: {
          detected_by: 'ruby_mitm_proxy',
          detected_at: Time.now.utc.iso8601,
          config_id: from_id,
          active_config_id: active_config_id,
          request: {
            headers: sanitized_sample_headers(request_headers),
            body: request_body_sample_body(request_body),
            parsed_json: parsed_response_sample_json(request_body),
            client_messages: client_messages
          }.compact,
          response: details.merge(
            headers: sanitized_sample_headers(response_headers),
            body: body_value,
            body_base64: encoded,
            body_bytes: body.to_s.bytesize,
            parsed_json: parsed_response_sample_json(body)
          ).compact
        }.compact
      )
      log "  failed request sample saved: #{path}"
    rescue => e
      log "  failed request sample failed: #{e.class}: #{e.message}"
    end

    def request_body_sample_body(body)
      return nil if body.nil?

      value, encoded = response_sample_body(body)
      encoded ? { body: value, body_base64: true } : value
    end

    def trace_session_id(request)
      headers = request[:headers] || {}
      direct = [headers['session-id'], headers['session_id']]
        .map { |value| value.to_s.strip }
        .find { |value| !value.empty? }
      return direct if direct

      metadata = JSON.parse(headers['x-codex-turn-metadata'].to_s)
      return nil unless metadata.is_a?(Hash)

      metadata['session_id'].to_s.strip.then { |value| value.empty? ? nil : value }
    rescue JSON::ParserError
      nil
    end

    def trace_enabled_for_user?(username)
      @auth_store.respond_to?(:trace_enabled_for_user?) && @auth_store.trace_enabled_for_user?(username)
    rescue => e
      log "  session trace lookup failed: #{e.class}: #{e.message}"
      false
    end

    def record_session_trace(username:, session_id:, enabled: trace_enabled_for_user?(username))
      return unless enabled
      return unless @auth_store.respond_to?(:record_session_trace)

      payload = yield
      path = @auth_store.record_session_trace(username: username, session_id: session_id, payload: payload)
      log "  session trace saved: #{path}" if path
    rescue => e
      log "  session trace failed: #{e.class}: #{e.message}"
    end

    def trace_payload(transport:, method:, url:, status:, elapsed:, started_at:, request_headers:, request_body:, response_headers:, response_body:, reason: nil, config_id: nil, websocket_messages: nil)
      {
        request_id: SecureRandom.hex(8),
        transport: transport,
        method: method,
        url: url,
        status: status,
        reason: reason,
        time: elapsed.round(3),
        started_at: started_at.utc.iso8601,
        completed_at: Time.now.utc.iso8601,
        config_id: config_id,
        active_config_id: active_config_id,
        request: {
          headers: request_headers
        }.merge(trace_body_fields(request_body, request_headers)).compact,
        response: {
          headers: response_headers
        }.merge(trace_body_fields(response_body, response_headers)).compact,
        websocket: websocket_messages
      }.compact
    end

    def trace_body_fields(body, headers = {})
      return { body_bytes: 0 } if body.nil?

      decoded_body, decoded_from, decode_error = decoded_trace_body(body, headers)
      stored_body = decoded_body || body
      body_value, encoded = response_sample_body(stored_body)
      {
        body: body_value,
        body_base64: (true if encoded),
        body_bytes: body.to_s.bytesize,
        decoded_body_bytes: decoded_body&.bytesize,
        body_decoded_from: decoded_from,
        body_decode_error: decode_error,
        parsed_json: parsed_response_sample_json(stored_body)
      }.compact
    end

    def decoded_trace_body(body, headers)
      encodings = trace_content_encodings(headers)
      return [nil, nil, nil] if encodings.empty? || body.to_s.empty?

      decoded = body.to_s.b
      applied = []
      encodings.reverse_each do |encoding|
        case encoding
        when 'identity'
          next
        when 'gzip', 'x-gzip'
          decoded = Zlib::GzipReader.new(StringIO.new(decoded)).read
        when 'zstd'
          decoded = decode_zstd_body(decoded)
        else
          return [nil, nil, "unsupported content-encoding: #{encoding}"]
        end
        applied << encoding
      end

      [decoded, applied.reverse.join(', '), nil]
    rescue => e
      [nil, nil, "#{e.class}: #{e.message}"]
    end

    def trace_content_encodings(headers)
      return [] unless headers.is_a?(Hash)

      headers['content-encoding'].to_s.downcase.split(',').map(&:strip).reject(&:empty?)
    end

    def decode_zstd_body(body)
      stdout, stderr, status = Open3.capture3(ZSTD_COMMAND, '-dcq', stdin_data: body)
      raise "zstd decode failed: #{stderr.to_s.strip}" unless status.success?

      stdout
    rescue Errno::ENOENT
      raise "zstd command not found: #{ZSTD_COMMAND}"
    end

    def response_sample_body(body)
      text = body.to_s.b
      utf8_text = text.dup.force_encoding(Encoding::UTF_8)
      return [utf8_text, false] if utf8_text.valid_encoding?

      [Base64.strict_encode64(text), true]
    end

    def parsed_response_sample_json(body)
      JSON.parse(body.to_s)
    rescue JSON::ParserError
      nil
    end

    def sanitized_sample_headers(headers)
      return nil unless headers.is_a?(Hash)

      headers.each_with_object({}) do |(key, value), clean|
        clean[key] = sensitive_header?(key) ? '[redacted]' : value
      end
    end

    def sensitive_header?(key)
      %w[authorization proxy-authorization cookie set-cookie].include?(key.to_s.downcase)
    end

    def usage_limit_response?(status, body, url: nil)
      return false if url && !usage_limit_detection_url?(url)
      return false if status && status.to_i != 429

      return true if structured_error_payloads_from_body(body).any? { |error| usage_limit_error?(error) }
      return false unless status

      text = body.to_s.downcase
      return false if text.empty?
      return true if USAGE_LIMIT_MARKERS.any? { |marker| text.include?(marker) }
      return true if text.include?('usage limit') && text.include?('upgrade to pro')

      text.match?(/rate.?limit|usage.?limit|insufficient.?quota|purchase more credits|over.?quota/)
    end

    def usage_limit_detection_url?(url)
      host = URI.parse(url).host.to_s.downcase
      host == 'chatgpt.com' || host.end_with?('.chatgpt.com') ||
        host == 'api.openai.com' || host.end_with?('.api.openai.com')
    rescue URI::InvalidURIError
      false
    end

    def usage_limit_websocket_response?(body)
      structured_error_payloads_from_body(body).any? { |error| usage_limit_error?(error) }
    end

    def cyber_policy_response?(body)
      cyber_policy_payloads_from_body(body).any?
    end

    def cyber_policy_message(body)
      payload = cyber_policy_payloads_from_body(body).first
      message = payload && cyber_policy_payload_message(payload)
      message.to_s.empty? ? 'Cyber policy response detected' : message[0, 1_000]
    end

    def cyber_policy_signal_from_body(body)
      cyber_policy_signals_from_body(body).first
    end

    def cyber_policy_signals_from_body(body)
      cyber_policy_payloads_from_body(body)
        .flat_map { |payload| cyber_policy_signals_from_payload(payload) }
        .uniq { |signal| [signal['case'], signal['value']] }
    end

    def failed_response_payload?(body)
      structured_error_payloads_from_body(body).any?
    end

    def usage_limit_error_payload?(value)
      error = structured_error_payload(value)
      error && usage_limit_error?(error)
    end

    def usage_limit_error?(error)
      return true if usage_limit_error_code_value?(error['code'] || error['type'])

      text = error['message'].to_s.downcase
      USAGE_LIMIT_MARKERS.any? { |marker| text.include?(marker) } ||
        (text.include?('usage limit') && text.include?('upgrade to pro'))
    end

    def cyber_policy_error?(error)
      CYBER_POLICY_ERROR_CODES.include?((error['code'] || error['type']).to_s.downcase)
    end

    def cyber_policy_payloads_from_body(body)
      json_values_from_body(body).flat_map { |value| cyber_policy_payloads(value) }
    end

    def cyber_policy_payloads(value)
      case value
      when Hash
        matches = []
        error = structured_error_payload(value)
        matches << error if error && cyber_policy_error?(error)
        matches << value if cyber_policy_session_flag?(value) ||
                           cyber_policy_verification_recommendation?(value) ||
                           cyber_policy_codex_error?(value)
        value.each_value { |child| matches.concat(cyber_policy_payloads(child)) }
        matches
      when Array
        value.flat_map { |child| cyber_policy_payloads(child) }
      else
        []
      end
    end

    def cyber_policy_payload_message(payload)
      message = payload['message'].to_s.strip
      return message unless message.empty?

      recommendation = cyber_policy_verification_recommendation(payload)
      return "OpenAI verification recommendation: #{recommendation}" if recommendation

      ''
    end

    def cyber_policy_signal_from_payload(payload)
      cyber_policy_signals_from_payload(payload).first
    end

    def cyber_policy_signals_from_payload(payload)
      return [] unless payload.is_a?(Hash)

      signals = []
      if cyber_policy_error?(payload)
        signals << { 'case' => 'error_code', 'value' => (payload['code'] || payload['type']).to_s }
      end

      error = structured_error_payload(payload)
      if error && cyber_policy_error?(error)
        signals << { 'case' => 'error_code', 'value' => (error['code'] || error['type']).to_s }
      end

      flag = cyber_policy_session_flag(payload)
      signals << { 'case' => 'session_flag', 'value' => flag } if flag

      recommendation = cyber_policy_verification_recommendation(payload)
      signals << { 'case' => 'verification_recommendation', 'value' => recommendation } if recommendation

      if cyber_policy_codex_error?(payload)
        signals << { 'case' => 'codex_error_info', 'value' => payload['codex_error_info'].to_s }
      end

      signals.uniq { |signal| signal['case'] }
    end

    def cyber_policy_session_flag?(value)
      !!cyber_policy_session_flag(value)
    end

    def cyber_policy_session_flag(value)
      return nil unless value.is_a?(Hash)

      flags = value['session_flags']
      return nil unless flags.is_a?(Array)

      (flags.map(&:to_s) & CYBER_POLICY_SESSION_FLAGS).first
    end

    def cyber_policy_verification_recommendation?(value)
      !!cyber_policy_verification_recommendation(value)
    end

    def cyber_policy_verification_recommendation(value)
      return nil unless value.is_a?(Hash)

      recommendations = value['openai_verification_recommendation']
      return nil unless recommendations.is_a?(Array)

      (recommendations.map(&:to_s) & CYBER_POLICY_VERIFICATION_RECOMMENDATIONS).first
    end

    def cyber_policy_codex_error?(value)
      return false unless value.is_a?(Hash)

      CYBER_POLICY_ERROR_CODES.include?(value['codex_error_info'].to_s.downcase)
    end

    def structured_error_payloads_from_body(body)
      json_values_from_body(body).filter_map { |value| structured_error_payload(value) }
    end

    def json_values_from_body(body)
      parsed = parsed_response_sample_json(body)
      parsed ? [parsed] : sse_json_values(body)
    end

    def sse_json_values(body)
      text = body.to_s
      return [] unless text.include?('data:')

      text.gsub("\r\n", "\n").split("\n\n").filter_map do |event|
        data = event.lines.filter_map do |line|
          line.start_with?('data:') ? line.delete_prefix('data:').strip : nil
        end.join
        next if data.empty? || data == '[DONE]'

        JSON.parse(data)
      rescue JSON::ParserError
        nil
      end
    end

    def structured_error_payload(value)
      return nil unless value.is_a?(Hash)

      error = value['error']
      return error if error.is_a?(Hash)
      return { 'message' => error } if value['type'].to_s == 'error' && error.is_a?(String)
      return value if value['type'].to_s == 'error' && (value['message'] || value['code'])

      nil
    end

    def usage_limit_error_code_value?(value)
      %w[
        insufficient_quota
        rate_limit_exceeded
        usage_limit_exceeded
        usage_limit_reached
      ].include?(value.to_s.downcase)
    end

    def usage_limit_message(body)
      message = body.to_s.gsub(/\s+/, ' ').strip
      message.empty? ? 'Usage limit response detected' : message[0, 1_000]
    end

    def forward_streaming_intercepted_request(request, io, fallback_host, fallback_port, scheme)
      monitor = CodexMonitor.open(request, 'sse')
      method = request[:method]
      path = request[:path]
      headers = request[:headers]
      body = request[:body]
      authority = headers['host'] || default_authority(fallback_host, fallback_port, scheme)
      client_url = absolute_url(scheme, authority, path)
      bridge_requested = codex_api_key_bridge_request?(request, fallback_host, fallback_port, scheme)
      bridge_plan = build_codex_api_key_bridge_plan if bridge_requested
      started_at = Time.now
      captured_body = +''
      chunk_count = 0
      streamed_bytes = 0
      status = nil
      body_allowed = true
      response_headers = {}
      unless !bridge_requested || bridge_plan
        log '  Codex API-key bridge unavailable'
        write_upstream_response(io, codex_api_key_bridge_unavailable_response)
        return
      end

      upstream_url = bridge_plan ? bridge_plan.fetch(:upstream_url) : client_url
      config_id = bridge_plan ? bridge_plan.fetch(:config_id) : active_config_id
      monitor&.source_config(config_id)
      trace_enabled = trace_enabled_for_user?(request[:proxy_username])
      session_id = trace_session_id(request) if trace_enabled

      log "  #{method} #{client_url} (SSE stream)"
      log_headers('  request headers', headers)
      log "  bridge upstream #{upstream_url}" if bridge_plan
      stream_request(method, upstream_url, headers, body, io, bridge_plan: bridge_plan) do |response, chunk|
        if response
          status = response_status(response)
          monitor&.headers(response_headers_hash(response), status)
          body_allowed = response_body_allowed?(status, method)
          response_headers = normalize_response_headers(response_headers_hash(response))
          log "  SSE <- #{status} #{response_header(response, 'content-type')} #{response_header(response, 'cache-control')}"
          log_headers('  response headers', response_headers)
          write_streaming_response_head(io, status, response_reason(response, status), response_headers, body_allowed: body_allowed)
        else
          chunk_count += 1
          streamed_bytes += chunk.bytesize
          monitor&.feed(chunk)
          append_stream_capture(captured_body, chunk)
          log_sse_chunk(chunk_count, chunk, streamed_bytes)
          write_chunk(io, chunk) if body_allowed
        end
      end
      write_final_chunk(io) if body_allowed

      elapsed = Time.now - started_at
      log "  SSE done: #{status || 0} #{chunk_count} chunks #{streamed_bytes}b retained=#{captured_body.bytesize}b #{format('%.3f', elapsed)}s"
      capture_request(
        method: method,
        url: client_url,
        status: status || 0,
        elapsed: elapsed,
        request_headers: headers,
        request_body: body,
        response_headers: response_headers,
        response_body: captured_body
      )
      record_session_trace(
        username: request[:proxy_username],
        session_id: session_id,
        enabled: trace_enabled
      ) do
        trace_payload(
          transport: 'sse',
          method: method,
          url: client_url,
          status: status || 0,
          elapsed: elapsed,
          started_at: started_at,
          config_id: config_id,
          request_headers: headers,
          request_body: body,
          response_headers: response_headers,
          response_body: captured_body
        )
      end
      if cyber_policy_response?(captured_body)
        record_cyber_policy_response_sample(
          captured_body,
          from_id: config_id,
          sample: {
            transport: 'sse',
            method: method,
            url: client_url,
            status: status,
            request_headers: headers,
            request_body: body,
            response_headers: response_headers
          }
        )
      elsif failed_response_payload?(captured_body)
        record_failed_response_sample(
          captured_body,
          from_id: config_id,
          sample: {
            transport: 'sse',
            method: method,
            url: client_url,
            status: status,
            request_headers: headers,
            request_body: body,
            response_headers: response_headers
          }
        )
      end
      record_token_usage(request[:proxy_username], captured_body, config_id: config_id)
    rescue => e
      log "  stream error: #{e.class}: #{e.message}"
      raise
    ensure
      monitor&.close
    end

    def append_stream_capture(buffer, chunk)
      # Retain the tail (including final usage/error events), not an unlimited
      # second copy of long-lived SSE/MCP streams. Forwarded chunks are untouched.
      if chunk.bytesize >= STREAM_CAPTURE_MAX_BYTES
        buffer.replace(chunk.byteslice(-STREAM_CAPTURE_MAX_BYTES, STREAM_CAPTURE_MAX_BYTES))
      else
        excess = buffer.bytesize + chunk.bytesize - STREAM_CAPTURE_MAX_BYTES
        buffer.replace(buffer.byteslice(excess, buffer.bytesize - excess)) if excess.positive?
        buffer << chunk
      end
    end

    def stream_request(method, url, headers, body, io, bridge_plan: nil, &block)
      uri = URI.parse(url)
      upstream_headers = sanitize_upstream_headers(headers, url: url, bridge_plan: bridge_plan)
      proxy_uri = upstream_proxy_for(uri)

      Sync do |task|
        task.with_timeout(Integer(ENV.fetch('UPSTREAM_TIMEOUT', '300'))) do
          if proxy_uri
            stream_request_via_async_proxy(method, url, upstream_headers, body, proxy_uri, io, &block)
          else
            stream_request_via_async_internet(method, url, upstream_headers, body, io, &block)
          end
        end
      end
    end

    def stream_request_via_async_internet(method, url, headers, body, io, &block)
      internet = RawAsyncInternet.new
      internet.call(method.upcase, url, headers, body) do |response|
        stream_async_response(response, io, &block)
      end
    ensure
      internet&.close
    end

    def stream_request_via_async_proxy(method, url, headers, body, proxy_uri, io, &block)
      endpoint = Async::HTTP::Endpoint[url]
      proxy_endpoint = Async::HTTP::Endpoint[proxy_uri.to_s]
      proxy_client = Async::HTTP::Client.new(proxy_endpoint)
      client = proxy_client.proxied_client(endpoint, async_proxy_headers(proxy_uri))
      request = Protocol::HTTP::Request[
        method.upcase,
        endpoint.path,
        headers,
        body,
        scheme: endpoint.scheme,
        authority: endpoint.authority
      ]
      response = client.call(request)
      stream_async_response(response, io, &block)
    ensure
      response&.close
      client&.close
      proxy_client&.close
    end

    def stream_async_response(response, io)
      yield response, nil
      response.each do |chunk|
        yield nil, chunk
        io.flush
      end
    end

    def async_proxy_headers(proxy_uri)
      return nil unless proxy_uri.user || proxy_uri.password

      [['proxy-authorization', proxy_authorization(proxy_uri)]]
    end

    def open_upstream_io(url, deadline: nil)
      uri = URI.parse(url)
      proxy_uri = upstream_proxy_for(uri)
      tcp = open_upstream_tcp(uri, proxy_uri, deadline: deadline)
      return tcp unless uri.scheme == 'https'

      ctx = OpenSSL::SSL::SSLContext.new
      ctx.verify_mode = OpenSSL::SSL::VERIFY_NONE
      ssl = OpenSSL::SSL::SSLSocket.new(tcp, ctx)
      ssl.hostname = uri.host if ssl.respond_to?(:hostname=)
      ssl.sync_close = true
      connect_upstream_tls(ssl, deadline: bounded_deadline(deadline, UPSTREAM_TLS_TIMEOUT))
      ssl
    rescue
      tcp&.close rescue nil
      raise
    end

    def write_raw_upstream_request(upstream, request, url: nil, bridge_plan: nil, deadline: nil)
      head = +"#{raw_upstream_request_line(request, url, bridge_plan: bridge_plan)}\r\n"
      sanitize_raw_upstream_headers(request[:headers], url: url, bridge_plan: bridge_plan).each do |key, value|
        head << "#{header_name(key)}: #{value}\r\n"
      end
      head << "\r\n"

      write_deadline = bounded_deadline(deadline, UPSTREAM_WRITE_TIMEOUT)
      write_upstream_data(upstream, head, deadline: write_deadline)
      write_upstream_data(upstream, request[:body], deadline: write_deadline) if request[:body]
      upstream.flush if upstream.respond_to?(:flush)
    end

    def raw_upstream_request_line(request, url, bridge_plan: nil)
      uri = URI.parse(url.to_s)
      if codex_api_key_bridge_snapshot(bridge_plan, url)
        method, _path, version = request[:request_line].split(' ', 3)
        return "#{method} #{request_uri(uri)} #{version}"
      end
      return request[:request_line] unless uri.scheme == 'http' && upstream_proxy_for(uri)

      method, _path, version = request[:request_line].split(' ', 3)
      "#{method} #{url} #{version}"
    rescue URI::InvalidURIError
      request[:request_line]
    end

    def open_upstream_tcp(uri, proxy_uri, deadline: nil)
      endpoint = proxy_uri || uri
      tcp = connect_upstream_tcp(endpoint.host, endpoint.port, deadline: deadline)
      return tcp unless proxy_uri
      return tcp if uri.scheme == 'http'

      write_proxy_connect(tcp, uri, proxy_uri, deadline: deadline)
      tcp
    rescue
      tcp&.close rescue nil
      raise
    end

    def write_proxy_connect(tcp, uri, proxy_uri, deadline: nil)
      authority = "#{uri.host}:#{uri.port}"
      request = +"CONNECT #{authority} HTTP/1.1\r\nHost: #{authority}\r\n"
      request << "Proxy-Authorization: #{proxy_authorization(proxy_uri)}\r\n" if proxy_uri.user || proxy_uri.password
      request << "\r\n"
      write_upstream_data(tcp, request, deadline: bounded_deadline(deadline, UPSTREAM_WRITE_TIMEOUT))
      tcp.flush if tcp.respond_to?(:flush)

      response_head = read_response_head(tcp, deadline: deadline, phase: :proxy_connect_response)
      _version, status, reason = response_head.lines.first.to_s.split(' ', 3)
      return if status.to_i == 200

      raise "upstream proxy CONNECT failed: #{status} #{reason.to_s.strip}"
    end

    def proxy_authorization(proxy_uri)
      credentials = "#{proxy_user(proxy_uri)}:#{proxy_password(proxy_uri)}"
      "Basic #{Base64.strict_encode64(credentials)}"
    end

    def proxy_user(proxy_uri)
      URI.decode_www_form_component(proxy_uri.user.to_s)
    end

    def proxy_password(proxy_uri)
      URI.decode_www_form_component(proxy_uri.password.to_s)
    end

    def upstream_proxy_for(uri)
      UpstreamProxy.uri_for(uri, prefixes: ['UPSTREAM_PROXY'])
    end

    def read_response_head(io, deadline: nil, phase: :upstream_response_header)
      read_deadline = bounded_deadline(deadline, UPSTREAM_HEADER_TIMEOUT)
      head = +''
      loop do
        chunk = read_upstream_data(io, READ_CHUNK, deadline: read_deadline, phase: phase)
        head << chunk
        break if head.include?("\r\n\r\n")
        raise "HTTP response header is too large" if head.bytesize > MAX_HEADER_BYTES
      end
      head
    end

    def connect_upstream_tcp(host, port, deadline: nil)
      connect_deadline = bounded_deadline(deadline, UPSTREAM_CONNECT_TIMEOUT)
      addresses = Addrinfo.getaddrinfo(
        host,
        port,
        nil,
        :STREAM,
        timeout: upstream_timeout_remaining(connect_deadline, :tcp_connect)
      )
      last_error = nil

      addresses.each do |address|
        begin
          return address.connect(timeout: upstream_timeout_remaining(connect_deadline, :tcp_connect))
        rescue SystemCallError => e
          last_error = e
        end
      end

      raise(last_error || SocketError.new("no address available for #{host}:#{port}"))
    rescue IO::TimeoutError, Errno::ETIMEDOUT
      raise_upstream_timeout(:tcp_connect)
    end

    def connect_upstream_tls(ssl, deadline:)
      loop do
        return ssl.connect_nonblock
      rescue IO::WaitReadable, OpenSSL::SSL::SSLErrorWaitReadable
        wait_for_upstream_io(ssl, :read, deadline, :tls_handshake)
      rescue IO::WaitWritable, OpenSSL::SSL::SSLErrorWaitWritable
        wait_for_upstream_io(ssl, :write, deadline, :tls_handshake)
      end
    end

    def write_upstream_data(io, data, deadline:, phase: :upstream_write)
      return io.write(data) unless io.respond_to?(:to_io) && io.respond_to?(:write_nonblock)

      offset = 0
      while offset < data.bytesize
        result = io.write_nonblock(data.byteslice(offset, data.bytesize - offset), exception: false)
        case result
        when :wait_readable
          wait_for_upstream_io(io, :read, deadline, phase)
        when :wait_writable
          wait_for_upstream_io(io, :write, deadline, phase)
        else
          raise IOError, 'upstream write returned no progress' unless result&.positive?

          offset += result
        end
      end
      offset
    end

    def read_upstream_data(io, length, deadline:, phase:)
      return io.readpartial(length) unless io.respond_to?(:to_io) && io.respond_to?(:read_nonblock)

      loop do
        result = io.read_nonblock(length, exception: false)
        case result
        when :wait_readable
          wait_for_upstream_io(io, :read, deadline, phase)
        when :wait_writable
          wait_for_upstream_io(io, :write, deadline, phase)
        else
          return result
        end
      end
    end

    def relay_websocket_rejection_body(upstream, client, response_head, response_headers, status)
      body = response_head.split("\r\n\r\n", 2)[1].to_s.dup
      return body unless response_body_allowed?(status, 'GET')

      if response_headers['transfer-encoding'].to_s.downcase.include?('chunked')
        until complete_chunked_message?(body)
          chunk = readpartial_with_timeout(
            upstream,
            READ_CHUNK,
            timeout: UPSTREAM_HEADER_TIMEOUT,
            label: 'upstream websocket rejection body'
          )
          body << chunk
          client.write(chunk)
        end
      elsif response_headers.key?('content-length')
        remaining = [response_headers['content-length'].to_i - body.bytesize, 0].max
        while remaining.positive?
          chunk = readpartial_with_timeout(
            upstream,
            [remaining, READ_CHUNK].min,
            timeout: UPSTREAM_HEADER_TIMEOUT,
            label: 'upstream websocket rejection body'
          )
          body << chunk
          client.write(chunk)
          remaining -= chunk.bytesize
        end
      else
        loop do
          chunk = readpartial_with_timeout(
            upstream,
            READ_CHUNK,
            timeout: UPSTREAM_HEADER_TIMEOUT,
            label: 'upstream websocket rejection body'
          )
          body << chunk
          client.write(chunk)
        end
      end
      body
    rescue EOFError
      body
    ensure
      client.flush
    end

    def complete_chunked_message?(body)
      offset = 0
      loop do
        line_end = body.index("\r\n", offset)
        return false unless line_end

        size_text = body.byteslice(offset, line_end - offset).to_s.split(';', 2).first
        return false unless size_text.match?(/\A[0-9a-f]+\z/i)

        size = size_text.to_i(16)
        offset = line_end + 2
        if size.zero?
          return true if body.byteslice(offset, 2) == "\r\n"

          return !body.index("\r\n\r\n", offset).nil?
        end

        return false if body.bytesize < offset + size + 2
        return false unless body.byteslice(offset + size, 2) == "\r\n"

        offset += size + 2
      end
    end

    def parse_response_head(head)
      header_text = head.split("\r\n\r\n", 2).first
      lines = header_text.split("\r\n")
      status_line = lines.shift.to_s
      _version, status, reason = status_line.split(' ', 3)
      [status.to_i, reason.to_s, parse_headers(lines)]
    end

    def relay_bidirectional(left, right)
      parent = Async::Task.current?
      return Sync { relay_bidirectional(left, right) } unless parent

      done = Async::Queue.new
      tasks = []
      track_active_opaque_relay do
        tasks << relay_stream_task(parent, done, left, right, 'client to upstream')
        tasks << relay_stream_task(parent, done, right, left, 'upstream to client')
        done.dequeue
      ensure
        close_relay_sockets(left, right)
        stop_relay_tasks(tasks)
      end
    end

    def relay_stream_task(parent, done, source, target, direction)
      parent.async(source, target, annotation: "opaque relay #{direction}") do |task, relay_source, relay_target|
        copy_stream(relay_source, relay_target)
      ensure
        done << task
      end
    end

    def stop_relay_tasks(tasks, kind: :opaque)
      tasks.each { |task| task.cancel unless task.finished? }
      deadline = monotonic_time + RELAY_STOP_TIMEOUT
      tasks.each do |task|
        task.wait(timeout: [remaining_timeout(deadline), 0].max)
      rescue Async::TimeoutError
        record_forced_relay_cleanup(tasks, kind)
        break
      end
    end

    def record_forced_relay_cleanup(tasks, kind)
      @metrics_mutex.synchronize do
        if kind == :websocket
          @forced_websocket_relay_cleanup_count += 1
        else
          @forced_relay_cleanup_count += 1
        end
      end
      label = kind == :websocket ? 'WebSocket' : 'Opaque'
      log "#{label} relay tasks did not stop within #{RELAY_STOP_TIMEOUT}s; forcing cleanup"
      tasks.each { |task| task.terminate unless task.finished? }
    end

    def close_relay_sockets(*sockets)
      sockets.each { |socket| socket.close rescue nil }
    end

    def copy_stream(source, target)
      loop do
        chunk = read_relay_chunk(source)
        break unless chunk

        write_relay_chunk(target, chunk)
      end
    rescue EOFError, IOError, SystemCallError, OpenSSL::SSL::SSLError
      nil
    end

    def read_relay_chunk(source)
      loop do
        chunk = source.read_nonblock(READ_CHUNK, exception: false)
        return chunk unless chunk == :wait_readable || chunk == :wait_writable

        wait_for_relay_io(source, chunk == :wait_readable ? :read : :write)
      end
    end

    def write_relay_chunk(target, chunk)
      offset = 0
      while offset < chunk.bytesize
        written = target.write_nonblock(chunk.byteslice(offset, chunk.bytesize - offset), exception: false)
        if written == :wait_readable || written == :wait_writable
          wait_for_relay_io(target, written == :wait_readable ? :read : :write)
        else
          raise IOError, 'opaque relay write returned no progress' unless written&.positive?

          offset += written
        end
      end
    end

    def wait_for_relay_io(io, direction)
      selectable = io.to_io
      direction == :read ? selectable.wait_readable : selectable.wait_writable
    end

    def relay_websocket(username, client, upstream, request: nil, url: nil, bridge_plan: nil, trace_enabled: false)
      parent = Async::Task.current?
      unless parent
        return Sync do
          relay_websocket(
            username,
            client,
            upstream,
            request: request,
            url: url,
            bridge_plan: bridge_plan,
            trace_enabled: trace_enabled
          )
        end
      end

      done = Async::Queue.new
      write_lock = Async::Semaphore.new(1, parent: parent)
      state = websocket_relay_state(upstream, trace_enabled: trace_enabled)
      state[:monitor] = CodexMonitor.open(request || {}, 'websocket')
      tasks = []
      track_active_websocket_relay do
        tasks << websocket_relay_task(parent, done, 'client to upstream') do
          relay_websocket_client_frames(client, state, write_lock)
        end
        tasks << websocket_relay_task(parent, done, 'upstream to client') do
          relay_websocket_server_frames(
            username,
            client,
            state,
            write_lock,
            request: request,
            url: url,
            bridge_plan: bridge_plan
          )
        end
        done.dequeue
      ensure
        state[:stopped] = true
        close_relay_sockets(client, state[:upstream])
        stop_relay_tasks(tasks, kind: :websocket)
      end
      websocket_trace_messages(state)
    ensure
      state&.fetch(:monitor, nil)&.close
      client.close rescue nil
      state&.fetch(:client_inflater, nil)&.close rescue nil
      state&.fetch(:upstream, nil)&.close rescue nil
    end

    def websocket_relay_state(upstream, trace_enabled:)
      {
        upstream: upstream,
        client_frames: [],
        client_frame_bytes: 0,
        replay_available: true,
        client_messages: [],
        client_inspection: {},
        client_inflater: Zlib::Inflate.new(-Zlib::MAX_WBITS),
        trace_client_messages: (trace_enabled ? [] : nil),
        trace_server_messages: (trace_enabled ? [] : nil),
        trace_retained_body_bytes: 0,
        trace_client_messages_dropped: 0,
        trace_client_messages_truncated: 0,
        trace_client_inspection_skipped: 0,
        trace_client_body_bytes_dropped: 0,
        trace_server_messages_dropped: 0,
        trace_server_messages_truncated: 0,
        trace_server_inspection_skipped: 0,
        trace_server_body_bytes_dropped: 0,
        retries: 0,
        stopped: false
      }
    end

    def websocket_relay_task(parent, done, direction)
      parent.async(annotation: "websocket relay #{direction}") do |task|
        yield
      ensure
        done << task
      end
    end

    def relay_websocket_client_frames(client, state, write_lock)
      loop do
        frame = read_websocket_frame(client)
        write_lock.acquire do
          return if state[:stopped]

          remember_websocket_client_frame(state, frame.fetch(:raw))
          record_client_websocket_frame(state, frame)
          write_websocket_frame(state[:upstream], frame.fetch(:raw))
        end
      end
    rescue EOFError, IOError, SystemCallError, OpenSSL::SSL::SSLError
      nil
    rescue => e
      log "  websocket client relay failed: #{e.class}: #{e.message}"
    end

    def remember_websocket_client_frame(state, raw)
      return unless state[:replay_available]

      bytes = state[:client_frame_bytes] + raw.bytesize
      if bytes > WEBSOCKET_REPLAY_MAX_BYTES
        state[:client_frames].clear
        state[:client_frame_bytes] = 0
        state[:replay_available] = false
      else
        state[:client_frames] << raw
        state[:client_frame_bytes] = bytes
      end
    end

    def relay_websocket_server_frames(username, target, state, write_lock, request: nil, url: nil, bridge_plan: nil)
      inspection = {}
      inflater = Zlib::Inflate.new(-Zlib::MAX_WBITS)
      loop do
        source = state[:upstream]
        frame = read_websocket_frame(source)
        inspected = inspect_websocket_frame(inspection, frame, inflater, message_opcodes: [0x1])
        text = inspected && inspected[:text]
        if inspected&.fetch(:inspection_skipped)
          record_websocket_inspection_skip(state, :server, inspected)
        elsif text
          record_server_websocket_message(state, text)
        end

        if text && usage_limit_websocket_response?(text) && retry_websocket_after_usage_limit(
          state,
          write_lock,
          request,
          url,
          text,
          bridge_plan: bridge_plan
        )
          inspection.clear
          inflater.close
          inflater = Zlib::Inflate.new(-Zlib::MAX_WBITS)
          next
        end

        if text && cyber_policy_response?(text)
          record_cyber_policy_response_sample(
            text,
            from_id: request && request[:active_config_id],
            sample: {
              transport: 'websocket',
              method: request && request[:method],
              url: url,
              request_headers: request && request[:headers],
              client_messages: state[:client_messages].dup
            }
          )
        elsif text && failed_response_payload?(text)
          record_failed_response_sample(
            text,
            from_id: request && request[:active_config_id],
            sample: {
              transport: 'websocket',
              method: request && request[:method],
              url: url,
              request_headers: request && request[:headers],
              client_messages: state[:client_messages].dup
            }
          )
        end

        write_websocket_frame(target, frame.fetch(:raw))
        record_token_usage(username, text, config_id: request && request[:active_config_id]) if text
      end
    rescue EOFError, IOError, SystemCallError, OpenSSL::SSL::SSLError
      nil
    rescue => e
      log "  websocket relay failed: #{e.class}: #{e.message}"
    ensure
      inflater&.close
    end

    def write_websocket_frame(io, raw)
      write_upstream_data(
        io,
        raw,
        deadline: monotonic_time + UPSTREAM_WRITE_TIMEOUT,
        phase: :websocket_write
      )
      io.flush if io.respond_to?(:flush)
    end

    def record_client_websocket_frame(state, frame)
      inspected = inspect_websocket_frame(
        state.fetch(:client_inspection),
        frame,
        state[:client_inflater],
        message_opcodes: [0x1, 0x2]
      )
      return unless inspected

      if inspected.fetch(:inspection_skipped)
        record_websocket_inspection_skip(state, :client, inspected)
      elsif inspected[:text]
        record_client_websocket_message(
          state,
          inspected.fetch(:text),
          inspected.fetch(:compressed),
          inspected.fetch(:opcode)
        )
      end
    end

    def record_client_websocket_message(state, payload, compressed, opcode)
      state[:monitor]&.client(payload)
      text = payload.to_s
      return if text.empty?

      state[:client_messages] << websocket_sample_message(text, opcode: opcode, compressed: compressed)
      state[:client_messages] = state[:client_messages].last(FAILED_REQUEST_CLIENT_MESSAGES)
      record_websocket_trace_message(state, :client, text, opcode: opcode, compressed: compressed)
    end

    def record_server_websocket_message(state, text)
      state[:monitor]&.server(text)
      record_websocket_trace_message(state, :server, text)
    end

    def inspect_websocket_frame(inspection, frame, inflater, message_opcodes:)
      opcode = frame.fetch(:opcode)
      if message_opcodes.include?(opcode)
        inspection.replace(
          active: true,
          payload: +'',
          body_bytes: 0,
          compressed: frame.fetch(:compressed),
          opcode: opcode,
          inspection_skipped: false
        )
      elsif opcode != 0x0 || !inspection[:active]
        return nil
      end

      append_websocket_inspection_payload(inspection, frame.fetch(:payload))
      return nil unless frame.fetch(:fin)

      complete_websocket_inspection(inspection, inflater)
    end

    def append_websocket_inspection_payload(inspection, payload)
      inspection[:body_bytes] += payload.bytesize
      return if inspection[:inspection_skipped]

      if inspection[:body_bytes] > WEBSOCKET_INSPECTION_MAX_BYTES
        inspection[:payload] = nil
        inspection[:inspection_skipped] = true
      else
        inspection[:payload] << payload
      end
    end

    def complete_websocket_inspection(inspection, inflater)
      result = inspection.dup
      unless result[:inspection_skipped]
        text, decoded_body_bytes, skipped = websocket_inspection_result(
          result.fetch(:payload),
          result.fetch(:compressed),
          inflater
        )
        result[:text] = text
        result[:decoded_body_bytes] = decoded_body_bytes if result[:compressed]
        result[:inspection_skipped] = skipped
      end
      result
    ensure
      inspection.clear
    end

    def websocket_inspection_result(payload, compressed, inflater)
      text = websocket_payload_text(
        payload,
        compressed,
        inflater,
        max_bytes: WEBSOCKET_INSPECTION_MAX_BYTES
      )
      [text, text.bytesize, false]
    rescue WebSocketInspectionLimit => e
      log "  websocket message inspection skipped: #{e.message}"
      [nil, e.body_bytes, true]
    rescue => e
      log "  websocket usage inspect failed: #{e.class}: #{e.message}"
      [nil, nil, false]
    end

    def record_websocket_trace_message(state, direction, text, opcode: nil, compressed: nil)
      messages = state[trace_state_key(direction, :messages)]
      return unless messages

      body_bytes = text.to_s.bytesize
      retained_bytes = websocket_trace_retained_bytes(state, messages, body_bytes)
      unless retained_bytes.positive?
        record_websocket_trace_drop(state, direction, body_bytes)
        return
      end

      retained_text = text.to_s.b.byteslice(0, retained_bytes)
      body_value, encoded = response_sample_body(retained_text)
      truncated = retained_bytes < body_bytes
      message = {
        at: Time.now.utc.iso8601,
        opcode: opcode,
        opcode_name: websocket_opcode_name(opcode),
        compressed: compressed,
        body: body_value,
        body_base64: encoded,
        body_bytes: body_bytes,
        retained_body_bytes: retained_bytes,
        body_truncated: (true if truncated),
        body_dropped_bytes: (body_bytes - retained_bytes if truncated),
        parsed_json: (parsed_response_sample_json(text) unless truncated)
      }.compact
      messages << message
      state[:trace_retained_body_bytes] += retained_bytes
      if truncated
        state[trace_state_key(direction, :messages_truncated)] += 1
        state[trace_state_key(direction, :body_bytes_dropped)] += body_bytes - retained_bytes
      end
    end

    def websocket_trace_retained_bytes(state, messages, body_bytes)
      return 0 if messages.length >= WEBSOCKET_TRACE_MAX_MESSAGES

      remaining = WEBSOCKET_TRACE_MAX_BYTES - state[:trace_retained_body_bytes]
      [body_bytes, WEBSOCKET_TRACE_MESSAGE_BYTES, remaining].min
    end

    def record_websocket_inspection_skip(state, direction, inspected)
      state[:monitor]&.gap('websocket_inspection_limit')
      messages = state[trace_state_key(direction, :messages)]
      return unless messages

      state[trace_state_key(direction, :inspection_skipped)] += 1
      if messages.length >= WEBSOCKET_TRACE_MAX_MESSAGES
        record_websocket_trace_drop(state, direction, inspected.fetch(:body_bytes))
        return
      end

      messages << {
        at: Time.now.utc.iso8601,
        opcode: inspected[:opcode],
        opcode_name: websocket_opcode_name(inspected[:opcode]),
        compressed: inspected[:compressed],
        body_bytes: inspected.fetch(:body_bytes),
        decoded_body_bytes: inspected[:decoded_body_bytes],
        inspection_skipped: true,
        inspection_limit_bytes: WEBSOCKET_INSPECTION_MAX_BYTES
      }.compact
    end

    def record_websocket_trace_drop(state, direction, body_bytes)
      state[trace_state_key(direction, :messages_dropped)] += 1
      state[trace_state_key(direction, :body_bytes_dropped)] += body_bytes
    end

    def trace_state_key(direction, suffix)
      "trace_#{direction}_#{suffix}".to_sym
    end

    def websocket_trace_messages(state)
      return unless state[:trace_client_messages]

      {
        client_messages: state[:trace_client_messages],
        server_messages: state[:trace_server_messages],
        retained_body_bytes: state[:trace_retained_body_bytes],
        client_messages_dropped: state[:trace_client_messages_dropped],
        client_messages_truncated: state[:trace_client_messages_truncated],
        client_inspection_skipped: state[:trace_client_inspection_skipped],
        client_body_bytes_dropped: state[:trace_client_body_bytes_dropped],
        server_messages_dropped: state[:trace_server_messages_dropped],
        server_messages_truncated: state[:trace_server_messages_truncated],
        server_inspection_skipped: state[:trace_server_inspection_skipped],
        server_body_bytes_dropped: state[:trace_server_body_bytes_dropped]
      }.compact
    end

    def websocket_sample_message(text, opcode: nil, compressed: nil)
      truncated = text.to_s.bytesize > FAILED_REQUEST_MESSAGE_BYTES
      body = truncated ? text.to_s.byteslice(0, FAILED_REQUEST_MESSAGE_BYTES) : text.to_s
      {
        opcode: opcode,
        opcode_name: websocket_opcode_name(opcode),
        compressed: compressed,
        body: body,
        body_truncated: truncated,
        body_bytes: text.to_s.bytesize,
        parsed_json: (parsed_response_sample_json(text) unless truncated)
      }.compact
    end

    def websocket_opcode_name(opcode)
      case opcode
      when 0x0 then 'continuation'
      when 0x1 then 'text'
      when 0x2 then 'binary'
      when 0x8 then 'close'
      when 0x9 then 'ping'
      when 0xa then 'pong'
      end
    end

    def read_websocket_frame(io)
      header = read_exact(io, 2)
      first = header.getbyte(0)
      second = header.getbyte(1)
      length = second & 0x7f
      length_bytes = length == 126 ? 2 : length == 127 ? 8 : 0
      extended = length_bytes.positive? ? read_exact(io, length_bytes) : +''
      length = extended.unpack1(length_bytes == 2 ? 'n' : 'Q>') if length_bytes.positive?
      raise IOError, 'WebSocket frame exceeds configured memory limit' if length > WEBSOCKET_FRAME_MAX_BYTES
      masked = (second & 0x80) != 0
      mask_key = masked ? read_exact(io, 4) : +''
      payload = read_exact(io, length)
      decoded = masked ? unmask_websocket_payload(payload, mask_key) : payload
      {
        raw: header + extended + mask_key + payload,
        fin: (first & 0x80) != 0,
        compressed: (first & 0x40) != 0,
        opcode: first & 0x0f,
        payload: decoded
      }
    end

    def read_exact(io, length)
      data = +''
      data << io.readpartial(length - data.bytesize) while data.bytesize < length
      data
    end

    def unmask_websocket_payload(payload, mask_key)
      decoded = payload.dup
      decoded.bytesize.times do |index|
        decoded.setbyte(index, decoded.getbyte(index) ^ mask_key.getbyte(index % 4))
      end
      decoded
    end

    def inspect_websocket_message(username, payload, compressed, inflater = nil)
      text = websocket_payload_text(
        payload,
        compressed,
        inflater,
        max_bytes: WEBSOCKET_INSPECTION_MAX_BYTES
      )
      record_token_usage(username, text)
      text
    rescue => e
      log "  websocket usage inspect failed: #{e.class}: #{e.message}"
    end

    def websocket_payload_text(payload, compressed, inflater = nil, max_bytes: nil)
      if !compressed && max_bytes && payload.bytesize > max_bytes
        raise WebSocketInspectionLimit.new(payload.bytesize)
      end

      local_inflater = compressed && inflater.nil? ? Zlib::Inflate.new(-Zlib::MAX_WBITS) : nil
      compressed ? inflate_websocket_message(payload, inflater || local_inflater, max_bytes: max_bytes) : payload
    ensure
      local_inflater&.close
    end

    def inflate_websocket_message(payload, inflater = nil, max_bytes: nil)
      local_inflater = inflater || Zlib::Inflate.new(-Zlib::MAX_WBITS)
      input = payload.b + "\x00\x00\xff\xff".b
      return local_inflater.inflate(input).force_encoding(Encoding::UTF_8) unless max_bytes

      output = +''
      output_bytes = 0
      inspection_skipped = false
      offset = 0
      while offset < input.bytesize
        chunk = local_inflater.inflate(input.byteslice(offset, WEBSOCKET_INFLATE_CHUNK_BYTES))
        output_bytes += chunk.bytesize
        if output_bytes > max_bytes
          inspection_skipped = true
          output.clear
        elsif !inspection_skipped
          output << chunk
        end
        offset += WEBSOCKET_INFLATE_CHUNK_BYTES
      end
      raise WebSocketInspectionLimit.new(output_bytes) if inspection_skipped

      output.force_encoding(Encoding::UTF_8)
    ensure
      local_inflater&.close unless inflater
    end

    def read_http_request(io)
      head = +''
      loop do
        chunk = readpartial_with_timeout(io, READ_CHUNK, timeout: CLIENT_READ_TIMEOUT, label: 'HTTP request header')
        head << chunk
        break if head.include?("\r\n\r\n")
        raise "HTTP header is too large" if head.bytesize > MAX_HEADER_BYTES
      end

      header_text, rest = head.split("\r\n\r\n", 2)
      lines = header_text.split("\r\n")
      request_line = lines.shift
      return nil if request_line.to_s.empty?

      headers = parse_headers(lines)
      method, path, = request_line.split(' ', 3)
      body = read_body(io, headers, rest || '')

      {
        request_line: request_line,
        method: method,
        path: path,
        headers: headers,
        body: body
      }
    rescue EOFError, IOError
      nil
    end

    def read_body(io, headers, buffered)
      if (length = headers['content-length']&.to_i) && length.positive?
        body = buffered.byteslice(0, length) || +''
        while body.bytesize < length
          body << readpartial_with_timeout(io, [length - body.bytesize, READ_CHUNK].min, timeout: CLIENT_READ_TIMEOUT, label: 'HTTP request body')
        end
        body
      elsif headers['transfer-encoding'].to_s.downcase.include?('chunked')
        read_chunked_body(io, buffered)
      else
        nil
      end
    end

    def read_chunked_body(io, buffered)
      data = buffered.dup
      loop do
        return data if data.include?("\r\n0\r\n\r\n") || data.include?("\r\n0\r\n")
        data << readpartial_with_timeout(io, READ_CHUNK, timeout: CLIENT_READ_TIMEOUT, label: 'chunked HTTP request body')
      end
    end

    def accept_tls_with_timeout(ssl)
      deadline = monotonic_time + CLIENT_READ_TIMEOUT
      loop do
        return ssl.accept_nonblock
      rescue IO::WaitReadable, OpenSSL::SSL::SSLErrorWaitReadable
        wait_for_io(ssl, :read, remaining_timeout(deadline), 'TLS handshake')
      rescue IO::WaitWritable, OpenSSL::SSL::SSLErrorWaitWritable
        wait_for_io(ssl, :write, remaining_timeout(deadline), 'TLS handshake')
      end
    end

    def bounded_deadline(deadline, timeout)
      phase_deadline = monotonic_time + timeout
      deadline ? [deadline, phase_deadline].min : phase_deadline
    end

    def upstream_timeout_remaining(deadline, phase)
      timeout = remaining_timeout(deadline)
      raise_upstream_timeout(phase) unless timeout.positive?

      timeout
    end

    def wait_for_upstream_io(io, direction, deadline, phase)
      selectable = io.to_io
      timeout = upstream_timeout_remaining(deadline, phase)
      ready = direction == :read ? selectable.wait_readable(timeout) : selectable.wait_writable(timeout)
      raise_upstream_timeout(phase) unless ready
    end

    def raise_upstream_timeout(phase)
      @metrics_mutex.synchronize do
        @upstream_timeout_count += 1
        @upstream_timeouts_by_phase[phase.to_s] += 1
        @last_upstream_timeout_at = Time.now.utc
        @last_upstream_timeout_phase = phase.to_s
      end
      raise UpstreamTimeout.new(phase)
    end

    def readpartial_with_timeout(io, length, timeout:, label:)
      wait_for_io(io, :read, timeout, label)
      io.readpartial(length)
    end

    def wait_for_io(io, direction, timeout, label)
      return unless io.respond_to?(:to_io)
      raise IOError, "#{label} timed out after #{timeout}s" if timeout <= 0

      selectable = io.to_io
      ready = direction == :read ? selectable.wait_readable(timeout) : selectable.wait_writable(timeout)
      raise IOError, "#{label} timed out after #{timeout}s" unless ready
    end

    def remaining_timeout(deadline)
      deadline - monotonic_time
    end

    def monotonic_time
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def websocket_gateway_timeout_response
      {
        status: 504,
        reason: 'Gateway Timeout',
        headers: { 'Content-Type' => 'text/plain' },
        body: "WebSocket upstream timed out\n"
      }
    end

    def write_upstream_response(io, response)
      body = response[:body].to_s
      headers = response[:headers].dup
      headers.delete('transfer-encoding')
      headers.delete('connection')
      headers['Content-Length'] = body.bytesize.to_s
      headers['Connection'] = 'close'

      io.write("HTTP/1.1 #{response[:status]} #{response[:reason]}\r\n")
      headers.each { |key, value| io.write("#{header_name(key)}: #{value}\r\n") }
      io.write("\r\n")
      io.write(body)
      io.flush
    end

    def write_streaming_response_head(io, status, reason, headers, body_allowed: true)
      headers = headers.dup
      headers.delete('content-length')
      headers.delete('transfer-encoding')
      headers.delete('connection')
      headers['Transfer-Encoding'] = 'chunked' if body_allowed
      headers['Connection'] = 'close'

      io.write("HTTP/1.1 #{status} #{reason}\r\n")
      headers.each { |key, value| io.write("#{header_name(key)}: #{value}\r\n") }
      io.write("\r\n")
      io.flush
    end

    def write_chunk(io, chunk)
      io.write(chunk.bytesize.to_s(16))
      io.write("\r\n")
      io.write(chunk)
      io.write("\r\n")
    end

    def write_final_chunk(io)
      io.write("0\r\n\r\n")
      io.flush
    end

    def write_json_response(socket, payload)
      write_response(socket, 200, 'OK', { 'Content-Type' => 'application/json' }, JSON.pretty_generate(payload))
    end

    def write_plain_response(socket, status, reason, body)
      write_response(socket, status, reason, { 'Content-Type' => 'text/plain' }, body)
    end

    def write_response(socket, status, reason, headers, body)
      headers = headers.merge('Content-Length' => body.bytesize.to_s, 'Connection' => 'close')
      socket.write("HTTP/1.1 #{status} #{reason}\r\n")
      headers.each { |key, value| socket.write("#{key}: #{value}\r\n") }
      socket.write("\r\n")
      socket.write(body)
      socket.flush
    end

    def parse_headers(lines)
      lines.each_with_object({}) do |line, headers|
        key, value = line.split(':', 2)
        headers[key.downcase] = value.to_s.strip if key && value
      end
    end

    def parse_authority(target)
      host, port = target.to_s.split(':', 2)
      [host, (port || 443).to_i]
    end

    def absolute_url(scheme, host, path)
      return path if path.start_with?('http://', 'https://')

      "#{scheme}://#{host}#{path}"
    end

    def default_authority(host, port, scheme)
      return host if (scheme == 'https' && port == 443) || (scheme == 'http' && port == 80)

      "#{host}:#{port}"
    end

    def request_uri(uri)
      uri.query ? "#{uri.path}?#{uri.query}" : uri.path
    end

    def sanitize_upstream_headers(headers, url: nil, bridge_plan: nil)
      credential_snapshot = codex_api_key_bridge_snapshot(bridge_plan, url)
      preserve_bridge_sentinel = !credential_snapshot && codex_api_key_bridge_sentinel_authorization?(headers['authorization'])
      clean = headers.each_with_object({}) do |(key, value), result|
        normalized_key = key.to_s.downcase
        next if %w[host connection proxy-connection proxy-authorization transfer-encoding content-length accept-encoding].include?(normalized_key)
        next if credential_snapshot && CODEX_API_KEY_BRIDGE_STRIPPED_HEADERS.include?(normalized_key)

        result[header_name(key)] = if preserve_bridge_sentinel
                                    value
                                  else
                                    substituted_header_value(
                                      key,
                                      value,
                                      url: url,
                                      credential_snapshot: credential_snapshot
                                    )
                                  end
      end
      add_codex_api_key_bridge_credentials(clean, credential_snapshot)
    end

    def sanitize_raw_upstream_headers(headers, url: nil, bridge_plan: nil)
      credential_snapshot = codex_api_key_bridge_snapshot(bridge_plan, url)
      preserve_bridge_sentinel = !credential_snapshot && codex_api_key_bridge_sentinel_authorization?(headers['authorization'])
      clean = headers.each_with_object({}) do |(key, value), result|
        normalized_key = key.to_s.downcase
        next if %w[proxy-connection proxy-authorization].include?(normalized_key)
        next if credential_snapshot && normalized_key == 'host'
        next if credential_snapshot && CODEX_API_KEY_BRIDGE_STRIPPED_HEADERS.include?(normalized_key)

        result[header_name(key)] = if preserve_bridge_sentinel
                                    value
                                  else
                                    substituted_header_value(
                                      key,
                                      value,
                                      url: url,
                                      credential_snapshot: credential_snapshot
                                    )
                                  end
      end
      if credential_snapshot
        uri = URI.parse(url)
        clean['Host'] = default_authority(uri.host, uri.port, uri.scheme)
      end
      add_codex_api_key_bridge_credentials(clean, credential_snapshot)
    end

    def add_codex_api_key_bridge_credentials(headers, credential_snapshot)
      return headers unless credential_snapshot

      headers['Authorization'] = credential_snapshot.fetch(:authorization)
      headers['Chatgpt-Account-Id'] = credential_snapshot.fetch(:account_id)
      headers
    end

    def substituted_header_value(key, value, url: nil, credential_snapshot: nil)
      return value if substitution_skipped_url?(url)

      case key.to_s.downcase
      when 'authorization'
        return credential_snapshot.fetch(:authorization) if credential_snapshot
        return value if codex_api_key_bridge_sentinel_authorization?(value)

        bearer_authorization?(value) ? (active_access_token || value) : value
      when 'chatgpt-account-id'
        credential_snapshot&.fetch(:account_id) || active_account_id || value
      when 'session_id', 'session-id'
        substituted_session_id(value, account_id: credential_snapshot&.fetch(:account_id)) || value
      when 'x-codex-turn-metadata'
        substituted_turn_metadata(value, account_id: credential_snapshot&.fetch(:account_id)) || value
      else
        value
      end
    end

    def substituted_turn_metadata(value, account_id: nil)
      metadata = JSON.parse(value.to_s)
      return nil unless metadata.is_a?(Hash) && metadata['session_id']

      session_id = substituted_session_id(metadata['session_id'], account_id: account_id)
      return nil unless session_id

      metadata['session_id'] = session_id
      JSON.generate(metadata)
    rescue JSON::ParserError
      nil
    end

    def substituted_session_id(value, account_id: nil)
      xor_uuid(value, account_id || active_config_account_id)
    end

    def xor_uuid(left, right)
      left_hex = uuid_hex(left)
      right_hex = uuid_hex(right)
      return nil unless left_hex && right_hex

      format_uuid((left_hex.to_i(16) ^ right_hex.to_i(16)).to_s(16).rjust(32, '0'))
    end

    def uuid_hex(value)
      hex = value.to_s.delete('-')
      hex.match?(/\A[0-9a-f]{32}\z/i) ? hex : nil
    end

    def format_uuid(hex)
      [8, 4, 4, 4, 12].map { |length| hex.slice!(0, length) }.join('-')
    end

    def bearer_authorization?(value)
      value.to_s.match?(/\ABearer\s+\S+/i)
    end

    def codex_api_key_bridge_sentinel_authorization?(value)
      value.to_s.match?(/\ABearer[ \t]+0000\z/i)
    end

    def codex_api_key_bridge_enabled?
      ENV.fetch('CODEX_API_KEY_BRIDGE_ENABLED', '1') == '1'
    end

    def codex_api_key_bridge_request?(request, fallback_host, fallback_port, scheme)
      return false unless codex_api_key_bridge_enabled?
      return false if request[:proxy_username].to_s.empty?
      return false unless scheme.to_s.downcase == 'https'
      return false unless request[:connect_authority].to_s.downcase == "#{CODEX_API_KEY_BRIDGE_SOURCE_HOST}:443"
      return false unless fallback_host.to_s.downcase == CODEX_API_KEY_BRIDGE_SOURCE_HOST
      return false unless fallback_port.to_i == 443
      return false unless %w[api.openai.com api.openai.com:443].include?(request.dig(:headers, 'host').to_s.downcase)
      return false unless request[:path].to_s == CODEX_API_KEY_BRIDGE_SOURCE_PATH
      return false unless request.dig(:headers, 'authorization').to_s == CODEX_API_KEY_BRIDGE_AUTHORIZATION

      (request[:method].to_s.upcase == 'POST' && !websocket_request?(request)) ||
        (request[:method].to_s.upcase == 'GET' && websocket_request?(request))
    end

    def build_codex_api_key_bridge_plan
      credential_snapshot = active_chatgpt_credential_snapshot
      return nil unless credential_snapshot

      {
        upstream_url: CODEX_API_KEY_BRIDGE_UPSTREAM_URL,
        credential_snapshot: credential_snapshot,
        config_id: credential_snapshot.fetch(:config_id)
      }.freeze
    end

    def codex_api_key_bridge_snapshot(bridge_plan, url)
      return nil unless bridge_plan
      return nil unless url.to_s == CODEX_API_KEY_BRIDGE_UPSTREAM_URL
      return nil unless bridge_plan[:upstream_url].to_s == CODEX_API_KEY_BRIDGE_UPSTREAM_URL

      bridge_plan[:credential_snapshot]
    end

    def active_chatgpt_credential_snapshot(now: Time.now.utc)
      config = @auth_store.active_config
      return nil unless config

      data = config[:data]
      tokens = data['tokens'] if data.is_a?(Hash)
      return nil unless tokens.is_a?(Hash)

      access_token = tokens['access_token']
      return nil unless access_token.is_a?(String)
      return nil if access_token.empty? || access_token != access_token.strip
      return nil if codex_api_key_bridge_access_token_expired?(access_token, now: now)

      account_ids = codex_api_key_bridge_account_ids(data, tokens)
      return nil unless account_ids.one?

      config_id = config.fetch(:id)
      return nil unless config_id.is_a?(String)
      return nil if config_id.empty? || config_id != config_id.strip

      config_id = config_id.dup.freeze
      account_id = account_ids.first.dup.freeze
      authorization = "Bearer #{access_token}".freeze
      {
        config_id: config_id,
        authorization: authorization,
        account_id: account_id
      }.freeze
    rescue KeyError, TypeError
      nil
    end

    def codex_api_key_bridge_account_ids(data, tokens)
      candidates = [
        data['account_id'],
        data['chatgpt-account-id'],
        data['chatgpt_account_id'],
        tokens['account_id'],
        tokens['chatgpt-account-id'],
        tokens['chatgpt_account_id'],
        tokens['id_token_account_id'],
        *jwt_account_id_candidates(tokens['access_token']),
        *jwt_account_id_candidates(tokens['id_token'])
      ].compact
      return [] unless candidates.all? do |candidate|
        candidate.is_a?(String) && !candidate.empty? && candidate == candidate.strip
      end

      candidates.uniq
    end

    def jwt_account_id_candidates(token)
      payload = decode_jwt_payload(token)
      return [] unless payload.is_a?(Hash)

      [
        payload.dig('https://api.openai.com/auth', 'chatgpt_account_id'),
        payload['chatgpt_account_id'],
        payload['account_id']
      ].compact
    end

    def codex_api_key_bridge_access_token_expired?(token, now:)
      payload = decode_jwt_payload(token)
      return false unless payload.is_a?(Hash) && payload.key?('exp')

      expires_at = payload['exp']
      return true unless expires_at.is_a?(Numeric) || expires_at.to_s.match?(/\A\d+\z/)

      expires_at.to_i <= now.to_i + CODEX_API_KEY_BRIDGE_EXPIRY_SKEW_SECONDS
    end

    def codex_api_key_bridge_unavailable_response
      {
        status: 503,
        reason: 'Service Unavailable',
        headers: { 'Content-Type' => 'text/plain' },
        body: CODEX_API_KEY_BRIDGE_UNAVAILABLE_BODY
      }
    end

    def substitution_skipped_url?(url)
      uri = URI.parse(url.to_s)
      uri.scheme == 'https' &&
        uri.host == 'auth.openai.com' &&
        %w[/oauth/token /oauth/authorize].include?(uri.path)
    rescue URI::InvalidURIError
      false
    end

    def active_access_token
      token = @auth_store.active_config&.dig(:data, 'tokens', 'access_token').to_s
      token.empty? ? nil : "Bearer #{token}"
    rescue
      nil
    end

    def active_config_id
      @auth_store.active_config&.fetch(:id)
    rescue
      nil
    end

    def active_config_account_id
      config = @auth_store.active_config
      account_id = config&.dig(:data, 'chatgpt-account-id') ||
                   config&.dig(:data, 'chatgpt_account_id') ||
                   config&.dig(:data, 'account_id') ||
                   config&.dig(:data, 'tokens', 'account_id') ||
                   config&.dig(:data, 'tokens', 'chatgpt-account-id') ||
                   config&.dig(:data, 'tokens', 'chatgpt_account_id') ||
                   jwt_account_id(config&.dig(:data, 'tokens', 'id_token'))
      account_id.to_s.empty? ? nil : account_id.to_s
    rescue
      nil
    end

    def active_account_id
      config = @auth_store.active_config
      tokens = config&.dig(:data, 'tokens')
      return nil unless tokens.is_a?(Hash)

      account_id = tokens['account_id'] ||
                   tokens['chatgpt_account_id'] ||
                   tokens['id_token_account_id'] ||
                   config.dig(:data, 'account_id') ||
                   jwt_account_id(tokens['access_token']) ||
                   jwt_account_id(tokens['id_token'])
      account_id.to_s.empty? ? nil : account_id.to_s
    rescue
      nil
    end

    def jwt_account_id(token)
      payload = decode_jwt_payload(token)
      payload&.dig('https://api.openai.com/auth', 'chatgpt_account_id')
    end

    def decode_jwt_payload(token)
      parts = token.to_s.split('.')
      return nil unless parts.size >= 2

      JSON.parse(Base64.urlsafe_decode64(pad_base64(parts[1])))
    rescue ArgumentError, JSON::ParserError
      nil
    end

    def pad_base64(value)
      value + ('=' * ((4 - value.length % 4) % 4))
    end

    def auth_required?
      true
    end

    def authenticated_username(request = nil, touch: true, **request_attributes)
      return 'anonymous' unless auth_required?

      request ||= request_attributes
      header = request[:headers]['proxy-authorization'].to_s
      scheme, credentials = header.split(' ', 2)
      return nil unless scheme.to_s.downcase == 'basic' && credentials.to_s != ''

      decoded = Base64.decode64(credentials)
      username, password = decoded.split(':', 2)
      @auth_store.authenticate_user(username, password, touch: touch) ? username : nil
    rescue
      nil
    end

    def record_token_usage(username, body, config_id: nil)
      usage = token_usage_from_body(body)
      return unless usage

      recorded_user = @auth_store.record_user_token_usage(username, usage)
      recorded_config = if config_id
                          @auth_store.record_config_token_usage(config_id, usage)
                        else
                          @auth_store.record_active_config_token_usage(usage)
                        end
      if recorded_user || recorded_config
        log "  token usage user=#{username} config=#{recorded_config} input=#{usage['input_tokens']} output=#{usage['output_tokens']} total=#{usage['total_tokens']}"
      end
    rescue => e
      log "  token usage record failed: #{e.class}: #{e.message}"
    end

    def token_usage_from_body(body)
      text = body.to_s
      return nil if text.empty?

      usages = text.include?("\nevent:") || text.start_with?('event:') ? token_usages_from_sse(text) : []
      usages << token_usage_from_json(JSON.parse(text)) if usages.empty?
      usages.compact.last
    rescue JSON::ParserError
      nil
    end

    def token_usages_from_sse(text)
      text.split(/\n\n+/).filter_map do |event|
        data = event.lines.filter_map do |line|
          line.start_with?('data:') ? line.sub(/\Adata:\s?/, '') : nil
        end.join
        next if data.strip.empty? || data.strip == '[DONE]'

        token_usage_from_json(JSON.parse(data))
      rescue JSON::ParserError
        nil
      end
    end

    def token_usage_from_json(value)
      case value
      when Hash
        usage = normalize_token_usage(value['usage'])
        return usage if usage

        value.each_value do |child|
          usage = token_usage_from_json(child)
          return usage if usage
        end
      when Array
        value.each do |child|
          usage = token_usage_from_json(child)
          return usage if usage
        end
      end
      nil
    end

    def normalize_token_usage(usage)
      return nil unless usage.is_a?(Hash)

      total = usage['total_tokens'] || usage['total_token_usage']
      input = usage['input_tokens'] || usage['input_token_usage']
      output = usage['output_tokens'] || usage['output_token_usage']
      cached_input = usage['cached_input_tokens'] || usage.dig('input_tokens_details', 'cached_tokens')
      reasoning_output = usage['reasoning_output_tokens'] || usage.dig('output_tokens_details', 'reasoning_tokens')
      return nil unless total || input || output

      {
        'input_tokens' => input.to_i,
        'cached_input_tokens' => cached_input.to_i,
        'output_tokens' => output.to_i,
        'reasoning_output_tokens' => reasoning_output.to_i,
        'total_tokens' => (total || input.to_i + output.to_i).to_i
      }
    end

    def write_proxy_auth_required(socket)
      write_response(
        socket,
        407,
        'Proxy Authentication Required',
        {
          'Content-Type' => 'text/plain',
          'Proxy-Authenticate' => 'Basic realm="RubyMITM"'
        },
        "Proxy authentication required\n"
      )
    end

    def normalize_response_headers(headers)
      header_pairs(headers).each_with_object({}) do |(key, value), clean|
        normalized_key = key.to_s.downcase
        next if %w[transfer-encoding connection content-length content-encoding].include?(normalized_key)

        value = value.to_s
        clean[normalized_key] = clean.key?(normalized_key) ? "#{clean[normalized_key]}, #{value}" : value
      end
    end

    def normalize_response_body(body, headers)
      return body unless headers['content-encoding'].to_s.include?('gzip') && body.bytesize.positive?

      Zlib::GzipReader.new(StringIO.new(body)).read
    rescue Zlib::GzipFile::Error
      body
    end

    def sse_request?(request)
      request[:headers]['accept'].to_s.downcase.split(',').any? do |type|
        type.strip.start_with?('text/event-stream')
      end
    end

    def websocket_request?(request)
      request[:headers]['upgrade'].to_s.downcase == 'websocket' &&
        request[:headers]['connection'].to_s.downcase.include?('upgrade')
    end

    def request_body?(method)
      !%w[GET HEAD DELETE OPTIONS TRACE].include?(method.to_s.upcase)
    end

    def keep_alive?(_request, _response)
      false
    end

    def response_body_allowed?(status, method = nil)
      return false if method.to_s.upcase == 'HEAD'

      code = status.to_i
      return false if code.between?(100, 199)

      ![204, 304].include?(code)
    end

    def response_status(response)
      response.respond_to?(:code) ? response.code.to_i : response.status.to_i
    end

    def response_reason(response, status)
      message = response.message if response.respond_to?(:message)
      message.to_s.empty? ? Rack::Utils::HTTP_STATUS_CODES.fetch(status.to_i, 'OK') : message
    end

    def response_header(response, key)
      return response[key] if response.respond_to?(:[])

      response.headers[key]
    end

    def response_headers_hash(response)
      return response.each_header.to_h if response.respond_to?(:each_header)

      header_pairs(response.headers).each_with_object({}) do |(key, value), headers|
        key = key.to_s
        value = value.to_s
        headers[key] = headers.key?(key) ? "#{headers[key]}, #{value}" : value
      end
    end

    def header_pairs(headers)
      return enum_for(:header_pairs, headers) unless block_given?

      headers.each do |entry|
        key, value = entry
        Array(value).each { |item| yield key, item }
      end
    end

    def ssl_context_for(hostname)
      cert_info = certificate_for(hostname)
      OpenSSL::SSL::SSLContext.new.tap do |ctx|
        ctx.cert = cert_info[:cert]
        ctx.key = cert_info[:key]
        ctx.verify_mode = OpenSSL::SSL::VERIFY_NONE
        ctx.min_version = OpenSSL::SSL::TLS1_2_VERSION
        ctx.alpn_protocols = ['http/1.1'] if ctx.respond_to?(:alpn_protocols=)
        ctx.alpn_select_cb = ->(_protocols) { 'http/1.1' } if ctx.respond_to?(:alpn_select_cb=)
      end
    end

    def certificate_for(hostname)
      CERT_MUTEX.synchronize do
        CERTS[hostname] ||= build_certificate(hostname)
      end
    end

    def build_certificate(hostname)
      key = OpenSSL::PKey::RSA.new(2048)
      cert = OpenSSL::X509::Certificate.new
      cert.version = 2
      cert.serial = SecureRandom.random_number(2**127)
      cert.subject = OpenSSL::X509::Name.parse("/CN=#{hostname}/O=RubyMITM/C=US")
      cert.issuer = @ca_cert.subject
      cert.not_before = Time.now - 3600
      cert.not_after = Time.now + 86_400 * 30
      cert.public_key = key.public_key

      extensions = OpenSSL::X509::ExtensionFactory.new
      extensions.subject_certificate = cert
      extensions.issuer_certificate = @ca_cert
      cert.add_extension(extensions.create_extension('basicConstraints', 'CA:FALSE', true))
      cert.add_extension(extensions.create_extension('keyUsage', 'digitalSignature,keyEncipherment', true))
      cert.add_extension(extensions.create_extension('extendedKeyUsage', 'serverAuth', false))
      cert.add_extension(extensions.create_extension('subjectAltName', "DNS:#{hostname}", false))
      cert.sign(@ca_key, OpenSSL::Digest::SHA256.new)

      log "Generated cert for #{hostname}"
      { key: key, cert: cert }
    end

    def capture_request(method:, url:, status:, elapsed:, request_headers:, request_body:, response_headers:, response_body:)
      return if MAX_CAPTURES <= 0

      CAPTURE_MUTEX.synchronize do
        CAPTURES << {
          method: method,
          url: url,
          status: status,
          time: elapsed.round(3),
          request_headers: request_headers,
          request_body: printable_body(request_body),
          response_headers: response_headers,
          response_body: printable_body(response_body),
          request_bytes: request_body.to_s.bytesize,
          response_bytes: response_body.to_s.bytesize,
          timestamp: Time.now.iso8601
        }
        CAPTURES.shift(CAPTURES.length - MAX_CAPTURES) if MAX_CAPTURES.positive? && CAPTURES.length > MAX_CAPTURES
      end
    end

    def stats_payload
      captures = CAPTURE_MUTEX.synchronize { CAPTURES.map(&:dup) }
      by_status = Hash.new(0)
      by_method = Hash.new(0)
      captures.each do |capture|
        by_status[capture[:status]] += 1
        by_method[capture[:method]] += 1
      end

      {
        total: captures.size,
        requests: captures.map do |capture|
          capture.slice(:method, :url, :status, :time, :request_bytes, :response_bytes, :timestamp)
        end,
        summary: {
          by_status: by_status,
          by_method: by_method,
          total_request_bytes: captures.sum { |capture| capture[:request_bytes] },
          total_response_bytes: captures.sum { |capture| capture[:response_bytes] }
        }
      }
    end

    def report_text
      captures = CAPTURE_MUTEX.synchronize { CAPTURES.map(&:dup) }
      lines = ["RubyMITM Report - #{Time.now.iso8601}", '=' * 80, '']

      captures.each_with_index do |capture, index|
        lines << "--- ##{index + 1}: #{capture[:method]} #{capture[:url]} ---"
        lines << "Status: #{capture[:status]} (#{capture[:time]}s)"
        lines << "Request headers: #{JSON.generate(capture[:request_headers])}"
        lines << "Request body:"
        lines << capture[:request_body].to_s
        lines << "Response headers: #{JSON.generate(capture[:response_headers])}"
        lines << "Response body:"
        lines << capture[:response_body].to_s
        lines << ''
      end

      lines.join("\n")
    end

    def printable_body(body)
      return nil if body.nil? || body.empty?

      printable = body.valid_encoding? ? body : Base64.strict_encode64(body)
      return printable if MAX_CAPTURE_BODY_BYTES <= 0 || printable.bytesize <= MAX_CAPTURE_BODY_BYTES

      "#{printable.byteslice(0, MAX_CAPTURE_BODY_BYTES)}\n... truncated #{printable.bytesize - MAX_CAPTURE_BODY_BYTES}b"
    end

    def log_body(prefix, body)
      return if MAX_LOG_BODY_BYTES <= 0

      printable = printable_body(body).to_s
      truncated = printable.bytesize > MAX_LOG_BODY_BYTES
      printable = printable.byteslice(0, MAX_LOG_BODY_BYTES) if truncated
      suffix = truncated ? " ... truncated #{body.bytesize - MAX_LOG_BODY_BYTES}b" : ''

      log "#{prefix}: #{printable.inspect}#{suffix}"
    end

    def log_sse_chunk(chunk_count, chunk, total_bytes)
      return unless SSE_CHUNK_LOG_INTERVAL.positive?
      return unless (chunk_count % SSE_CHUNK_LOG_INTERVAL).zero?

      log "  SSE chunk ##{chunk_count}: #{chunk.bytesize}b total=#{total_bytes}b"
      log_body("  SSE chunk ##{chunk_count} body", chunk)
    end

    def log_headers(prefix, headers)
      redacted = headers.transform_values.with_index do |value, index|
        key = headers.keys[index].to_s.downcase
        %w[authorization proxy-authorization cookie set-cookie].include?(key) ? '[redacted]' : value
      end
      log "#{prefix}: #{JSON.generate(redacted)}"
    end

    def header_name(key)
      key.to_s.split('-').map(&:capitalize).join('-')
    end

    def log(message)
      puts "[#{Time.now.strftime('%H:%M:%S.%L')}] #{message}"
      $stdout.flush
    end
  end
end

RubyMITM::Server.new.run if $PROGRAM_NAME == __FILE__
