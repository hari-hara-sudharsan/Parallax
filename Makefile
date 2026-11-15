# Thin wrapper: every target forwards to ./tw.sh so there is one source of truth.
# Windows users without `make` can run ./tw.sh <task> directly in Git Bash.
TASKS := help wallet get-react install build test rehearse demo-pool deploy-tokens create-pool add-liquidity push-down push-up pool-state deploy-reactive deploy-executor add-chain deploy-parallax create-stop-loss create-take-profit create-range-guard fund-reactive fund-executor debts rule bench abis callbacks

.PHONY: $(TASKS)
$(TASKS):
	@./tw.sh $@
