# Host tests of the Qt-free parts of the agent. Not shipped.
#
#   make -C device-agent/tools test
#
# Opt-in emulator test (not part of `test`): starts the SDK emulator from a snapshot, see
# emulator/emulator-test.py. Builds its helpers in the platform SDK container (docker/IMAGE).
#
#   make -C device-agent/tools emulator-test [VM=name] [HEADLESS=1] [CASES=abgfechdu]

CXX ?= g++
CXXFLAGS ?= -std=c++11 -O2 -Wall -Wextra
BUILD ?= $(or $(TMPDIR),/tmp)/sailfish-devagent-tools-$(shell id -u)

.PHONY: test emulator-test clean

test: $(BUILD)/pacer-test $(BUILD)/stats-test $(BUILD)/firstline-test $(BUILD)/retrybudget-test $(BUILD)/idleplan-test $(BUILD)/yuvrows-test $(BUILD)/childlink-test $(BUILD)/streamlimits-test
	$(BUILD)/pacer-test
	$(BUILD)/stats-test
	$(BUILD)/firstline-test
	$(BUILD)/retrybudget-test
	$(BUILD)/idleplan-test
	$(BUILD)/yuvrows-test
	$(BUILD)/childlink-test
	$(BUILD)/streamlimits-test

$(BUILD)/%-test: %-test.cpp ../mirror/pacer.h ../stats/statsmath.h ../common/firstline.h ../mirror/retrybudget.h ../common/idleplan.h ../mirror/yuvrows.h ../common/linebuffer.h ../common/streamlimits.h
	mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -I ../common -I ../stats -I ../mirror $< -o $@

DOCKER ?= docker
IMAGE = $(shell grep -v '^[[:space:]]*\#' ../docker/IMAGE | grep -v '^[[:space:]]*$$' | head -n 1)
EMULATOR = $(BUILD)/emulator

emulator-test: $(EMULATOR)/clip $(EMULATOR)/uitouch
	python3 emulator/emulator-test.py --helpers $(EMULATOR) $(if $(VM),--vm "$(VM)") $(if $(CASES),--cases $(CASES))

# The source goes in on stdin and the binary comes back on stdout: no mounts, no file ownership.
$(EMULATOR)/%: emulator/%.c
	mkdir -p $(EMULATOR)
	$(DOCKER) run --rm -i $(IMAGE) sh -c 'cd && cat > t.c && sb2 -t SailfishOS-5.1.0.11-i486 gcc -O2 -std=gnu99 -Wall -o t t.c >&2 && cat t' < $< > $@.part
	mv $@.part $@

clean:
	rm -rf $(BUILD)
