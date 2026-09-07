require 'minitest/autorun'
require 'tmpdir'
require_relative 'observer'

class ObserverTest < Minitest::Test
  class MemorySink
    attr_reader :events
    def initialize;@events=[];end
    def emit(scope,type,data);@events<<{**scope,type:type,data:data};end
  end
  def capture(transport='sse')
    @sink=MemorySink.new
    CodexMonitor::Capture.new(@sink,'test',{'session-id'=>'session-a'},transport,JSON.generate({model:'test-model',input:'Тестовое поручение'}))
  end
  def test_sse_utf8_and_split_multiline_frame
    c=capture
    payload="event: response.output_text.delta\r\ndata: "+JSON.generate({type:'response.output_text.delta',item_id:'item1',delta:'Привет, мир!'})+"\r\n\r\n"
    payload.bytes.each{|b|c.feed(b.chr)}
    c.feed("data: "+JSON.generate({type:'response.completed',response:{output:[{id:'item1',type:'message',content:[{text:'Привет, мир!'}]}],usage:{input_tokens:10,output_tokens:3,total_tokens:13}}})+"\n\n")
    c.close
    texts=@sink.events.select{|e|e[:type]=='item.snapshot'}.map{|e|e[:data][:text]}
    assert_includes texts,'Привет, мир!'
    assert_equal 1,@sink.events.count{|e|e[:type]=='usage.snapshot'}
    assert_equal 'completed',@sink.events.select{|e|e[:type]=='request.updated'}.last[:data][:status]
  end
  def test_split_secret_never_published
    c=capture
    secret='sk-proj-'+('Ab7Z9cdE'*40)
    text='Размышление. API_KEY="'+secret+'" Продолжаем. '+('Обычный текст. '*40)
    text.chars.each_slice(9){|chunk|c.server({type:'response.reasoning_summary_text.delta',item_id:'r1',delta:chunk.join})}
    c.close
    all=JSON.generate(@sink.events)
    refute_includes all,secret
    refute_includes all,secret[0,40]
    assert_includes all,CodexMonitor::REDACTED
  end
  def test_no_local_execution_or_run_completion_inferred
    c=capture('websocket')
    c.server({type:'response.output_item.done',item:{id:'call1',type:'function_call',name:'exec',call_id:'abc',arguments:'{"cmd":"pwd"}'}})
    c.server({type:'response.completed',response:{output:[]}})
    c.close
    assert @sink.events.any?{|e|e[:type]=='item.snapshot'&&e[:data][:kind]=='tool_call'}
    refute @sink.events.any?{|e|e[:type].start_with?('run.')||e[:type]=='tool.completed'}
  end
  def test_retry_separate_attempt_same_request
    c=capture;c.retry;c.close
    starts=@sink.events.select{|e|e[:type]=='request.started'}
    assert_equal starts[0][:requestId],starts[1][:requestId]
    refute_equal starts[0][:attemptId],starts[1][:attemptId]
  end
  def test_unassigned_connections_stay_separate
    sink=MemorySink.new
    a=CodexMonitor::Capture.new(sink,'user',{},'http')
    b=CodexMonitor::Capture.new(sink,'user',{},'http')
    refute_equal sink.events[0][:sessionId],sink.events[1][:sessionId]
    a.close;b.close
  end
  def test_bounded_spool_does_not_block
    Dir.mktmpdir do |dir|
      sink=CodexMonitor::Sink.new(dir,max_bytes:100,queue_size:2)
      start=Time.now
      1000.times{sink.emit({sessionId:'s'},'source.status',{text:'x'*500})}
      assert_operator Time.now-start,:<,0.5
      sink.drain
      assert_empty Dir.glob(File.join(dir,'*.json'))
      sink.stop
    end
  end
  def test_secret_and_system_fields_excluded
    c=capture
    c.client({model:'test',input:[{role:'system',content:'private instructions'},{type:'reasoning',id:'x',encrypted_content:'secretblob',summary:[]}]})
    c.close
    refute_includes JSON.generate(@sink.events),'private instructions'
    refute_includes JSON.generate(@sink.events),'secretblob'
  end
  def test_interleaved_websocket_responses_keep_their_attempts
    sink=MemorySink.new
    c=CodexMonitor::WebSocketCapture.new(sink,'test',{'session-id'=>'same-session'})
    %w[first second].each{|name|c.client(JSON.generate({type:'response.create',model:'qa',input:name}))}
    %w[a b].each{|id|c.server(JSON.generate({type:'response.created',response:{id:id,model:'qa'}}))}
    %w[a b].each{|id|c.server(JSON.generate({type:'response.output_item.added',response_id:id,item:{id:'item-'+id,type:'message'}}))}
    %w[b a].each{|id|c.server(JSON.generate({type:'response.output_text.delta',item_id:'item-'+id,delta:'Ответ '+id}))}
    %w[b a].each{|id|c.server(JSON.generate({type:'response.completed',response:{id:id,output:[{id:'item-'+id,type:'message',content:[{text:'Ответ '+id}]}]}}))}
    c.close
    a=sink.events.find{|e|e[:type]=='item.snapshot'&&e[:data][:text]=='Ответ a'}
    b=sink.events.find{|e|e[:type]=='item.snapshot'&&e[:data][:text]=='Ответ b'}
    refute_nil a;refute_nil b
    refute_equal a[:attemptId],b[:attemptId]
    assert_equal a[:sessionId],b[:sessionId]
  end
  def test_gzip_sse_is_decoded_incrementally
    c=capture;c.headers({'content-encoding'=>'gzip'},200)
    frame="data: "+JSON.generate({type:'response.output_item.done',item:{id:'gz',type:'message',content:[{text:'Сжатый поток'}]}})+"\n\n"
    io=StringIO.new;gz=Zlib::GzipWriter.new(io);gz.write(frame);gz.close
    io.string.bytes.each_slice(7){|bytes|c.feed(bytes.pack('C*'))};c.close
    assert @sink.events.any?{|e|e[:type]=='item.snapshot'&&e[:data][:text]=='Сжатый поток'}
  end
  def test_connection_notifications_do_not_steal_pending_request
    sink=MemorySink.new;c=CodexMonitor::WebSocketCapture.new(sink,'test',{'session-id'=>'real-session'})
    c.client(JSON.generate({type:'response.create',model:'qa',input:'hello'}))
    c.server(JSON.generate({type:'rate_limits.updated',rate_limits:[]}))
    c.server(JSON.generate({type:'response.in_progress'}))
    c.server(JSON.generate({type:'response.created',response:{id:'r1',model:'qa'}}))
    c.server(JSON.generate({type:'response.completed',response:{id:'r1',usage:{input_tokens:3,output_tokens:2,total_tokens:5}}}))
    c.server(JSON.generate({type:'rate_limits.updated',rate_limits:[]}));c.close
    assert_equal 1,sink.events.select{|e|e[:type]=='request.started'}.length
    assert_equal 1,sink.events.map{|e|e[:sessionId]}.uniq.length
    assert_equal 1,sink.events.filter_map{|e|e[:attemptId]}.uniq.length
  end
  def test_basic_header_and_quoted_multiline_password_are_fully_redacted
    text=CodexMonitor.clean("Authorization: Basic dXNlcjpwYXNzd29yZA==\npassword: \"two word\nsecret\"")
    refute_includes text,'dXNlcjpwYXNzd29yZA=='
    refute_includes text,'two word'
    refute_includes text,"\nsecret"
    partial=CodexMonitor.clean('password: "unfinished multi word secret')
    refute_includes partial,'multi word'
  end
end
