# The agent's marketplace path on Cloudflare (#144 option A): the pinned taskfast
# release behind a one-route server. It holds no state and no secrets; the agent's
# Durable Object sends its config with each call.
FROM debian:bookworm-slim AS fetch
ARG TAG=taskfast-cli-v0.21.0
ARG SHA256=1df1aa7ec142353369916ad6cb2d03091e8f01f89acf62791055d6747fe98899
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /cli.tar.xz "https://github.com/Akuja-Inc/taskfast-cli/releases/download/${TAG}/taskfast-cli-x86_64-unknown-linux-gnu.tar.xz" \
 && echo "${SHA256}  /cli.tar.xz" | sha256sum -c - \
 && tar -xJf /cli.tar.xz -C / && mv /taskfast-cli-x86_64-unknown-linux-gnu/taskfast /usr/local/bin/taskfast

FROM node:24-bookworm-slim
# The CLI's HTTP client needs the system roots, which the slim image leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /usr/local/bin/taskfast /usr/local/bin/taskfast
COPY server.mjs /srv/server.mjs
USER node
EXPOSE 8080
CMD ["node", "/srv/server.mjs"]
