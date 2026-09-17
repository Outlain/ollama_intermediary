# Supply the exact running bb6c2e9 image, ideally its immutable repo digest.
# No default prevents accidentally selecting a moving development tag.
ARG FRIGATE_BASE_IMAGE
FROM ${FRIGATE_BASE_IMAGE}
COPY apply_bridge.py bridge.py /opt/ollama-intermediary-bridge/
RUN python3 /opt/ollama-intermediary-bridge/apply_bridge.py /opt/frigate
# Opt in explicitly in your Frigate Compose environment after configuring
# the description provider to use the intermediary. Disabled by default.
ENV FRIGATE_INTERMEDIARY_BRIDGE=0
LABEL org.opencontainers.image.description="Frigate bb6c2e9 with optional Ollama intermediary attempt bridge"
