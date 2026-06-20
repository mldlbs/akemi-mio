// Akemi Mio Writing MCP Server — PM2 配置
// 部署方式：
// 1. 将 writing-mcp.js 上传到服务器 /opt/akemi-mio-writing/
// 2. 在该目录下放此文件，运行:
//    pm2 start ecosystem.writing.js
// 3. nginx 反向代理配置见下方注释

const path = require('path')

module.exports = {
  apps: [{
    name: 'akemi-mio-writing-mcp',
    script: path.join(__dirname, 'writing-mcp.js'),
    env: {
      PORT: '3301',
      WRITING_API: 'http://127.0.0.1:3300',
    },
    watch: false,
    max_memory_restart: '200M',
    error_file: path.join(__dirname, 'logs', 'err.log'),
    out_file: path.join(__dirname, 'logs', 'out.log'),
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
}

/*
=== Nginx 反向代理配置 ===
在 nginx.conf 的 server 块中添加：

    location /writing-mcp/ {
        proxy_pass http://127.0.0.1:3301;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

=== 本地 AI 连接方式 ===
在 chat 中告诉 AI：
"请使用 connect_mcp_server 工具连接写作系统 MCP：
  name: writing-system
  url: https://www.crlkcloud.cyou/writing-mcp/sse
  transport: sse"

然后 AI 就可以用结构化的 writing_* 工具直接操作写作系统了。
*/
