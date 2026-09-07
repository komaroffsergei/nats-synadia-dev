ARG BASE_IMAGE=ruby-mitm-proxy:0.3.90-memory-fix-20260906
FROM ${BASE_IMAGE}
COPY docker/monitor/observer.rb /app/monitor/observer.rb
COPY docker/monitor/proxy.rb /app/proxy/proxy.rb
ENV MONITOR_ENABLED=false MONITOR_OUTBOX=/data/monitor-outbox MONITOR_OUTBOX_MAX_BYTES=268435456
RUN ruby -c /app/monitor/observer.rb && ruby -c /app/proxy/proxy.rb
