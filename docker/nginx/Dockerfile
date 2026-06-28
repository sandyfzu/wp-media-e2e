# Bakes the WordPress vhost into the image so no host bind-mount is needed (portable across
# Docker setups, incl. Lima VMs that don't share the project path).
FROM nginx:1.27-alpine
COPY default.conf /etc/nginx/conf.d/default.conf
