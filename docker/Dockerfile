# Build context is the repository root:
#   docker build -f docker/Dockerfile --build-arg BUN_VERSION="$(cat .bun-version)" -t integrations .

ARG BUN_VERSION
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS build
ARG TARGETARCH
ARG VERSION
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --os linux --cpu '*'
RUN if [ -n "$VERSION" ]; then bun run scripts/release-version.ts apply --version "$VERSION"; fi
RUN bun run build:control-plane
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64-baseline ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && bun run release:build --target "$target" --outfile /out/integrations \
  && mkdir -p /out/data

FROM gcr.io/distroless/cc-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/mokronos/integrations" \
      org.opencontainers.image.description="Self-hosted integrations gateway and dashboard" \
      org.opencontainers.image.licenses="MIT"
ENV INTEGRATIONS_HOME=/data
COPY --from=build /out/integrations /usr/local/bin/integrations
COPY --from=build --chown=nonroot:nonroot /out/data /data
VOLUME ["/data"]
EXPOSE 4788
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=1s --retries=3 CMD ["/usr/local/bin/integrations", "health"]
ENTRYPOINT ["/usr/local/bin/integrations"]
CMD ["serve", "--host", "0.0.0.0", "--port", "4788"]
