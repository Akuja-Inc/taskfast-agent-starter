# Option A of #144: the pinned taskfast CLI as a stateless image. The caller
# mounts the config, keystore and password file read-only per command; the
# image holds no state and no secrets.
FROM debian:bookworm-slim AS fetch
ARG TAG=taskfast-cli-v0.21.0
ARG SHA256=1df1aa7ec142353369916ad6cb2d03091e8f01f89acf62791055d6747fe98899
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /cli.tar.xz "https://github.com/Akuja-Inc/taskfast-cli/releases/download/${TAG}/taskfast-cli-x86_64-unknown-linux-gnu.tar.xz" \
 && echo "${SHA256}  /cli.tar.xz" | sha256sum -c - \
 && tar -xJf /cli.tar.xz -C / && mv /taskfast-cli-x86_64-unknown-linux-gnu/taskfast /usr/local/bin/taskfast

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home agent
COPY --from=fetch /usr/local/bin/taskfast /usr/local/bin/taskfast
USER agent
WORKDIR /agent
ENTRYPOINT ["/usr/local/bin/taskfast"]
