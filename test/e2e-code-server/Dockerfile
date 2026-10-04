# syntax=docker/dockerfile:1
# code-server e2e image for igv-vscode (spec §11.2, §12 M4).
#
# Build context layout (assembled by run.mjs into test/e2e-code-server/.context/):
#   igv-vscode.vsix        the packaged extension (copied from the repo root)
#   entrypoint.sh          writes settings.json from $TRANSPORT_MODE, then starts code-server
#   data/ref.fa            fixtures from test/fixtures/generated/
#   data/ref.fa.fai
#   data/small.bam
#   data/small.bam.bai
#   data/genes.bed
#
#   docker build --build-arg CODE_SERVER_VERSION=4.140.0 -t igv-vscode-e2e:4.140.0 \
#                -f test/e2e-code-server/Dockerfile test/e2e-code-server/.context
ARG CODE_SERVER_VERSION=4.140.0
FROM codercom/code-server:${CODE_SERVER_VERSION}
ARG CODE_SERVER_VERSION
LABEL org.opencontainers.image.title="igv-vscode code-server e2e" \
      org.opencontainers.image.description="code-server ${CODE_SERVER_VERSION} with the igv-vscode VSIX installed, no system node"

USER root
# Acceptance criterion (spec §12 M4): the CLI must work without a system node.
# Remove every node/nodejs binary that could be on PATH. code-server's own
# runtime stays at /usr/lib/code-server/lib/node, which is not on PATH; the
# extension bakes that absolute path into its launcher script.
RUN rm -f /usr/bin/node /usr/local/bin/node /usr/bin/nodejs /usr/local/bin/nodejs /bin/node /bin/nodejs || true; \
    if command -v node >/dev/null 2>&1; then echo "node is still on PATH: $(command -v node)" >&2; exit 1; fi
COPY entrypoint.sh /usr/local/bin/igv-e2e-entrypoint.sh
RUN chmod 0755 /usr/local/bin/igv-e2e-entrypoint.sh

USER coder
ENV HOME=/home/coder
WORKDIR /home/coder

# Install the extension into the default extensions dir (~/.local/share/code-server/extensions).
COPY --chown=coder:coder igv-vscode.vsix /tmp/igv-vscode.vsix
RUN code-server --install-extension /tmp/igv-vscode.vsix && rm -f /tmp/igv-vscode.vsix

# Workspace: /home/coder/project with the fixtures under data/ and an out/ dir
# that the test reads back with `docker exec` / `docker cp`.
COPY --chown=coder:coder data/ /home/coder/project/data/
RUN mkdir -p /home/coder/project/out /home/coder/.local/share/code-server/User

# shim (default) or webviewUri; consumed by entrypoint.sh, which writes
# ~/.local/share/code-server/User/settings.json before code-server starts.
ENV TRANSPORT_MODE=shim

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/igv-e2e-entrypoint.sh"]
CMD ["--auth", "none", "--bind-addr", "0.0.0.0:8080", "--disable-telemetry", "--disable-update-check", "--disable-workspace-trust", "/home/coder/project"]
