VENV=.venv_capsule
PY=$(VENV)/bin/python
PIP=$(VENV)/bin/pip
ENV?=.env

gateway:
	$(VENV)/bin/uvicorn gateway.handoff_gateway:app --host 0.0.0.0 --port 9911

encode:
	scripts/capsule_cli.sh encode > system.pcap.json && echo "Wrote system.pcap.json"

decode:
	test -f system.pcap.json || (echo "missing system.pcap.json"; exit 1)
	scripts/capsule_cli.sh decode

