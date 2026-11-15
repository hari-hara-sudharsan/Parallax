# Thin wrapper: every target forwards to ./tw.sh so there is one source of truth.
# Windows users without `make` can run ./tw.sh <task> directly in Git Bash.
TASKS := help wallet install build test rehearse demo-pool deploy-tokens create-pool add-liquidity push-down push-up pool-state deploy-reactive deploy-executor set-executor deploy-tripwire create-stop-loss fund-reactive fund-executor debts

.PHONY: $(TASKS)
$(TASKS):
	@./tw.sh $@
