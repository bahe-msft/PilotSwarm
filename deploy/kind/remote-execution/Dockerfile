ARG BASE_IMAGE=localhost/pilotswarm-remote-base:dev
FROM ${BASE_IMAGE}
COPY --chown=node:node examples/remote-execution/ /app/examples/remote-execution/
ENTRYPOINT ["node", "examples/remote-execution/worker.mjs"]
