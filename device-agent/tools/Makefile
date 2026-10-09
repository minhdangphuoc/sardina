# Host tests of the Qt-free parts of the agent. Not shipped.
#
#   make -C device-agent/tools test

CXX ?= g++
CXXFLAGS ?= -std=c++11 -O2 -Wall -Wextra
BUILD ?= $(or $(TMPDIR),/tmp)/sailfish-devagent-tools-$(shell id -u)

.PHONY: test clean

test: $(BUILD)/pacer-test $(BUILD)/stats-test $(BUILD)/firstline-test $(BUILD)/retrybudget-test $(BUILD)/idleplan-test $(BUILD)/yuvrows-test $(BUILD)/childlink-test
	$(BUILD)/pacer-test
	$(BUILD)/stats-test
	$(BUILD)/firstline-test
	$(BUILD)/retrybudget-test
	$(BUILD)/idleplan-test
	$(BUILD)/yuvrows-test
	$(BUILD)/childlink-test

$(BUILD)/%-test: %-test.cpp ../mirror/pacer.h ../stats/statsmath.h ../common/firstline.h ../mirror/retrybudget.h ../common/idleplan.h ../mirror/yuvrows.h ../common/linebuffer.h
	mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -I ../common -I ../stats -I ../mirror $< -o $@

clean:
	rm -rf $(BUILD)
