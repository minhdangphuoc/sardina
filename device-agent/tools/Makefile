# Host tests of the Qt-free parts of the agent. Not shipped.
#
#   make -C device-agent/tools test

CXX ?= g++
CXXFLAGS ?= -std=c++11 -Wall -Wextra
BUILD ?= $(or $(TMPDIR),/tmp)/sailfish-devagent-tools-$(shell id -u)

.PHONY: test clean

test: $(BUILD)/pacer-test $(BUILD)/stats-test $(BUILD)/firstline-test $(BUILD)/retrybudget-test
	$(BUILD)/pacer-test
	$(BUILD)/stats-test
	$(BUILD)/firstline-test
	$(BUILD)/retrybudget-test

$(BUILD)/%-test: %-test.cpp ../src/pacer.h ../src/statsmath.h ../src/firstline.h ../src/retrybudget.h
	mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -I ../src $< -o $@

clean:
	rm -rf $(BUILD)
