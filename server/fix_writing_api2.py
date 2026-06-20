#!/usr/bin/env python3
import os

# 1. Nginx: remove /writing/, keep only /writing-api/ with prefix strip
nginx_conf = '/usr/local/nginx/conf/nginx.conf'
with open(nginx_conf, 'r') as f:
    c = f.read()

old_writing = '''    location /writing/ {
        proxy_pass http://127.0.0.1:3300/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }'''

old_writing_api = '''    location /writing-api/ {
        rewrite ^/writing-api/(.*) /api/$1 break;
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }'''

new_writing_api = '''    location /writing-api/ {
        rewrite ^/writing-api/(.*) /$1 break;
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }'''

c = c.replace(old_writing, '').replace(old_writing_api, new_writing_api)
with open(nginx_conf, 'w') as f:
    f.write(c)
print('nginx updated')

# 2. Frontend JS: fix API paths - they already have /writing-api/ prefix, now need /writing-api/api/
public_dir = '/opt/writing-system/public'
for fn in os.listdir(public_dir):
    if fn.endswith('.js'):
        fp = os.path.join(public_dir, fn)
        with open(fp) as f:
            content = f.read()
        new_content = content.replace("'/writing-api/", "'/writing-api/api/").replace('"/writing-api/', '"/writing-api/api/')
        if content != new_content:
            with open(fp, 'w') as f:
                f.write(new_content)
            print(f'updated {fn}')

# 3. index.html: change relative paths to /writing-api/ absolute
fp = os.path.join(public_dir, 'index.html')
with open(fp) as f:
    content = f.read()
new_content = content.replace('href="./', 'href="/writing-api/').replace('src="./', 'src="/writing-api/')
with open(fp, 'w') as f:
    f.write(new_content)
print('updated index.html')
