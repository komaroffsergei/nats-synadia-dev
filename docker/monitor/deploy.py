"""Run on VPS as root. No credentials are printed or stored in source control."""
from pathlib import Path
import subprocess as sp, json, secrets, shutil, time, re, sys, urllib.request

release=sys.argv[1]
assert re.fullmatch(r'[a-f0-9]{7,40}',release)
mode=sys.argv[2] if len(sys.argv)>2 else 'prepare'
root=Path('/srv/portfolio/monitor');root.mkdir(mode=0o700,exist_ok=True)
backup=root/'releases'/release;backup.mkdir(parents=True,exist_ok=True,mode=0o700)
def run(*args):
    p=sp.run(args,stdout=sp.PIPE,stderr=sp.STDOUT,text=True)
    if p.returncode: raise RuntimeError('Command failed: '+args[0]+' '+str(p.returncode))
    return p.stdout
def put(path,text):
    p=Path(path);p.write_text(text);p.chmod(0o600)
def save(path,name):
    dest=backup/name
    if not dest.exists():shutil.copy2(path,dest)
def wait(url,seconds=90):
    for _ in range(seconds):
        try:
            with urllib.request.urlopen(url,timeout=2) as r:
                if r.status==200:return
        except Exception:pass
        time.sleep(1)
    raise RuntimeError('Health check failed: '+url)

proxy=Path('/opt/codex-proxy/compose.yaml')
agents=Path('/srv/portfolio/agents/compose.yaml')
nats=Path('/srv/portfolio/infrastructure/nats.conf')
nginx=Path('/etc/nginx/sites-available/portfolio-demos.conf')
for path,name in [(proxy,'proxy-compose.yaml'),(agents,'agents-compose.yaml'),(nats,'nats.conf'),(nginx,'nginx.conf')]:save(path,name)

if mode=='prepare':
    for folder in ['state','outbox','status']:(root/folder).mkdir(exist_ok=True,mode=0o700)
    keys_path=root/'keys.json'
    if keys_path.exists():keys=json.loads(keys_path.read_text())
    else:
        keys={k:secrets.token_hex(32) for k in ['publisher','projector','admin','ingress']};put(keys_path,json.dumps(keys))
    text=nats.read_text()
    if 'CODEX_MONITOR {' not in text:
        text=text.replace('max_file_store: 128MB','max_file_store: 1400MB')
        pos=text.rfind('}')
        account='''
 CODEX_MONITOR {
  users: [
   {user: "trace-publisher", password: "%s", permissions: {publish: ["codex.trace.>"], subscribe: ["_INBOX.>"]}}
   {user: "trace-projector", password: "%s", permissions: {publish: ["$JS.API.CONSUMER.INFO.CODEX_TRACE.console-projector", "$JS.API.CONSUMER.MSG.NEXT.CODEX_TRACE.console-projector", "$JS.ACK.CODEX_TRACE.>", "$JS.FC.CODEX_TRACE.>"], subscribe: ["_INBOX.>"]}}
   {user: "trace-admin", password: "%s"}
  ]
  jetstream {max_mem: 8MB, max_file: 1100MB, max_streams: 1, max_consumers: 4}
 }
'''%(keys['publisher'],keys['projector'],keys['admin'])
        candidate=root/'nats-candidate.conf';put(candidate,text[:pos]+account+text[pos:])
        image=run('docker','inspect','portfolio-infra-nats-1','--format','{{.Image}}').strip()
        run('docker','run','--rm','-v',str(candidate)+':/etc/nats/check.conf:ro',image,'-t','-c','/etc/nats/check.conf')
        # Preserve bind-mounted inode for reload. Restore original on failure.
        put(nats,candidate.read_text())
        try:
            run('docker','kill','--signal','HUP','portfolio-infra-nats-1')
            time.sleep(2)
            # JetStream storage limits require a restart in NATS 2.11.
            run('docker','restart','portfolio-infra-nats-1')
        except Exception:
            put(nats,(backup/'nats.conf').read_text());run('docker','restart','portfolio-infra-nats-1');raise
    image='synadia-monitor:'+release
    put(root/'projector.env',f'NATS_TRACE_URL=nats://trace-projector:{keys["projector"]}@portfolio-infra-nats-1:4222\nMONITOR_INGRESS_KEY={keys["ingress"]}\nMONITOR_ORIGIN=https://agents.komaroff-dev.ru\nMONITOR_REVISION={release}\n')
    put(root/'publisher.env',f'NATS_TRACE_URL=nats://trace-publisher:{keys["publisher"]}@portfolio-infra-nats-1:4222\n')
    put(root/'setup.env',f'NATS_TRACE_URL=nats://trace-admin:{keys["admin"]}@portfolio-infra-nats-1:4222\n')
    run('docker','run','--rm','--network','portfolio-backend','--env-file',str(root/'setup.env'),image,'bun','run','examples/agent-web-ui/server/monitor/setup.ts')
    compose=f'''name: portfolio-monitor
x-common: &common
 image: {image}
 pull_policy: never
 restart: unless-stopped
 networks: [backend, edge]
 cpus: 0.5
 pids_limit: 100
 logging: {{driver: json-file, options: {{max-size: "5m", max-file: "3"}}}}
services:
 projector:
  <<: *common
  command: [bun, run, examples/agent-web-ui/server/monitor/service.ts]
  env_file: projector.env
  volumes: ["./state:/data", "./status:/status:ro"]
  ports: ["127.0.0.1:18406:3310"]
  mem_limit: 256m
  healthcheck: {{test: [CMD, bun, -e, "fetch('http://127.0.0.1:3310/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: 15s, timeout: 5s, retries: 6}}
 publisher:
  <<: *common
  command: [bun, run, examples/agent-web-ui/server/monitor/ingest.ts]
  env_file: publisher.env
  volumes: ["./outbox:/outbox", "./status:/status"]
  mem_limit: 128m
  healthcheck: {{test: [CMD, bun, -e, "const s=await Bun.file('/status/ingest.json').json();process.exit(Date.now()-Date.parse(s.at)<30000?0:1)"], interval: 15s, timeout: 5s, retries: 6}}
networks:
 backend: {{external: true, name: portfolio-backend}}
 edge: {{external: true, name: portfolio-edge}}
'''
    put(root/'compose.yaml',compose)
    run('docker','compose','-f',str(root/'compose.yaml'),'up','-d');wait('http://127.0.0.1:18406/healthz')
    print('Dedicated stream, separate credentials and monitor backend ready',flush=True)
    # The worker explicitly remains on its previous image.
    text=(backup/'agents-compose.yaml').read_text().replace(' api:\n  <<: *app',' api:\n  <<: *app\n  image: '+image)
    put(agents,text)
    run('docker','compose','-f',str(agents),'up','-d','--no-deps','api');wait('http://127.0.0.1:18405/healthz')
    text=nginx.read_text()
    pattern=r'server\s*\{[^{}]*listen\s+443\s+ssl;\s*server_name\s+agents\.komaroff-dev\.ru;'
    match=re.search(pattern,text)
    if not match:raise RuntimeError('Agents TLS block not found')
    start=match.start();depth=0;end=None
    for i in range(text.index('{',start),len(text)):
        if text[i]=='{':depth+=1
        if text[i]=='}':
            depth-=1
            if depth==0:end=i+1;break
    assert end
    common='''proxy_http_version 1.1;
 proxy_set_header Host $host;
 proxy_set_header X-Real-IP $remote_addr;
 proxy_set_header X-Forwarded-Proto $scheme;
 proxy_set_header Upgrade $http_upgrade;
 proxy_set_header Connection "upgrade";
 proxy_read_timeout 100s;'''
    auth='auth_basic "Codex Gateway"; auth_basic_user_file /etc/nginx/.htpasswd-codex;'
    trust=f'proxy_set_header X-Monitor-Key {keys["ingress"]}; proxy_set_header X-Monitor-Owner $remote_user;'
    block='''server {
 listen 443 ssl;
 server_name agents.komaroff-dev.ru;
 ssl_certificate /etc/letsencrypt/live/agents.komaroff-dev.ru/fullchain.pem;
 ssl_certificate_key /etc/letsencrypt/live/agents.komaroff-dev.ru/privkey.pem;
 ssl_protocols TLSv1.2 TLSv1.3;
 add_header X-Content-Type-Options nosniff always;
 add_header Referrer-Policy no-referrer always;
 add_header X-Frame-Options SAMEORIGIN always;
 add_header Cache-Control no-store always;
 client_max_body_size 1m;
'''
    for location,port,extra in [('/console',18405,auth),('/api/v1/monitor/',18406,auth+trust),('= /monitor/ws',18406,auth+trust),('/api/public/',18406,'access_log off;'),('= /public/ws',18406,'access_log off;'),('= /ws',18405,auth),('= /youtrack/webhook',18405,''),('/youtrack/',18405,auth),('/live/',18405,'access_log off;'),('/',18405,'')]:
        block+=f' location {location} {{ {extra}\n {common}\n proxy_pass http://127.0.0.1:{port};\n }}\n'
    block+='}\n'
    put(nginx,text[:start]+block+text[end:])
    try:run('nginx','-t');run('systemctl','reload','nginx')
    except Exception:put(nginx,(backup/'nginx.conf').read_text());raise
    print('Owner console protected; public index contains published sessions only',flush=True)
    text=(backup/'proxy-compose.yaml').read_text()
    text=re.sub(r'(?m)^(\s*image:)\s*.*$',r'\1 codex-proxy-monitor:'+release,text,count=1)
    text=text.replace('    environment:\n','    environment:\n      MONITOR_ENABLED: "false"\n      MONITOR_USERS: ""\n')
    text=text.replace('    volumes:\n','    volumes:\n      - /srv/portfolio/monitor/outbox:/data/monitor-outbox\n')
    put(proxy,text)
    run('docker','compose','-f',str(proxy),'up','-d','--no-build','--no-deps','codex-proxy')
    wait('http://127.0.0.1:17000/healthcheck')
    print('Proxy observer released with capture disabled',flush=True)

elif mode in ['canary','all','off']:
    users=[]
    for path in Path('/opt/codex-proxy/data/users').glob('*.json'):
        value=json.loads(path.read_text());name=value.get('username') or path.stem
        users.append((path.stat().st_mtime,name))
    users.sort(reverse=True)
    selected=users[:1] if mode=='canary' else users
    names=','.join(n for _,n in selected) if mode!='off' else ''
    text=proxy.read_text()
    text=re.sub(r'MONITOR_ENABLED:.*',f'MONITOR_ENABLED: "{str(mode!="off").lower()}"',text)
    text=re.sub(r'MONITOR_USERS:.*','MONITOR_USERS: '+json.dumps(names),text)
    put(proxy,text)
    run('docker','compose','-f',str(proxy),'up','-d','--no-build','--no-deps','codex-proxy')
    wait('http://127.0.0.1:17000/healthcheck')
    print(json.dumps({'mode':mode,'sources':len(selected) if mode!='off' else 0,'proxy':'healthy'}),flush=True)

elif mode=='rollback':
    for path,name in [(proxy,'proxy-compose.yaml'),(agents,'agents-compose.yaml'),(nginx,'nginx.conf')]:put(path,(backup/name).read_text())
    run('nginx','-t');run('systemctl','reload','nginx')
    run('docker','compose','-f',str(agents),'up','-d','--no-deps','api')
    run('docker','compose','-f',str(proxy),'up','-d','--no-build','--no-deps','codex-proxy')
    wait('http://127.0.0.1:17000/healthcheck');wait('http://127.0.0.1:18405/healthz')
    print('Previous proxy and UI restored; monitor data retained',flush=True)
else:raise RuntimeError('Unknown operation')
