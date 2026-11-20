# Test Report — MultiSigTimelockWallet

---

## 1. Test Environment

- **Test Suite File**: `test/MultiSigTimelockWallet.test.js`
- **Helper Contract**: `contracts/test/ReentrancyAttacker.sol`
- **Compiler & EVM**: Solidity `0.8.20` (Optimizer enabled, `200` runs, `HardhatEVM v2.29.2`)
- **Test Signers**: 6 accounts (`owner1`, `owner2`, `owner3`, `nonOwner`, `recipient`, `extraOwner`)
- **Default Fixture Parameters**: 3 owners, `THRESHOLD = 2`, `DELAY = 60 seconds`, `GRACE_PERIOD = 7 days (604,800 seconds)`, initial wallet funding `10.0 ETH`

---

## 2. Automated Test Results Table (T1 to T23)

All 28 test cases in `test/MultiSigTimelockWallet.test.js` executed and passed (`28 passing (1s)`).

| Test ID | Test Description | Expected Behaviour | Actual Result |
| :- | :--- | :--- | :-: |
| **T1** | Constructor stores `owners`, `threshold`, and `delay` | `getOwners()` matches input array, `threshold() == 2`, `delay() == 60`, `isOwner` true for all 3 owners | **PASS** |
| **T2** | Invalid threshold (`1` or `4` with 3 owners) | Reverts with custom error `InvalidThreshold` | **PASS** |
| **T3** | Duplicate owner or `address(0)` owner in constructor | Reverts with custom error `InvalidOwner` | **PASS** |
| **T3b** | Fewer than 3 owners (`2`) or more than 10 owners (`11`) | Reverts with custom error `InvalidOwner` | **PASS** |
| **T3c** | Delay out of bounds (`9s < 10s` or `> 30 days`) | Reverts with custom error `InvalidDelay` | **PASS** |
| **T4** | Sending ETH to wallet triggers `receive()` | Emits `Deposited(sender, amount, balanceAfter)` and increases balance | **PASS** |
| **T5** | Non-owner calls `submit()` | Reverts with custom error `NotOwner` | **PASS** |
| **T6** | Owner calls `submit()` | Creates `Pending` tx (`id = 0`), auto-approves proposer (`approvalCount == 1`), emits `Submitted` & `Approved` | **PASS** |
| **T7** | Second owner calls `approve(0)` | Reaches threshold (`2/2`), sets status `Queued`, sets `unlockTime = block.timestamp + 60`, emits `Approved` & `Queued` | **PASS** |
| **T8** | Same owner calls `approve(0)` twice | Reverts with custom error `AlreadyApproved` | **PASS** |
| **T9** | Owner calls `execute(0)` before 60s delay finishes | Reverts with custom error `TooEarly` | **PASS** |
| **T10** | Owner calls `execute(0)` after 60s delay | Transfers exact ETH to `recipient`, sets status `Executed` (`3`), emits `Executed` | **PASS** |
| **T11** | Second `execute(0)` call on an already executed tx | Reverts with custom error `NotQueued` | **PASS** |
| **T12** | `execute(0)` called after `unlockTime + 7 days` | `isExpired(0) == true`, `getStatus(0) == 5`, `execute(0)` reverts with `Expired` | **PASS** |
| **T13** | `revoke(0)` while `Queued` drops approvals below threshold | Emits `Revoked`, demotes status back to `Pending` (`1`), clears `unlockTime = 0` | **PASS** |
| **T14** | Re-approving after `revoke(0)` | Sets status `Queued` with a brand-new `unlockTime` strictly greater than the first `unlockTime` | **PASS** |
| **T15** | Proposer calls `voteCancel(0)` | Immediately sets status `Cancelled` (`4`), emits `Cancelled`; subsequent `execute(0)` reverts `NotQueued` | **PASS** |
| **T16** | Non-proposer owners call `voteCancel(0)` | 1 vote leaves status `Pending` (`cancelCount == 1`); 2nd vote reaches threshold and sets `Cancelled` (`4`) | **PASS** |
| **T16b** | Non-proposer owner calls `voteCancel(0)` twice | Reverts with custom error `AlreadyApproved` | **PASS** |
| **T17** | Direct call to `addOwner`, `removeOwner`, `changeThreshold`, `changeDelay` from an owner EOA | All 4 calls revert with custom error `NotSelf` | **PASS** |
| **T18** | Full governance flow: propose `addOwner(extraOwner)` to wallet, approve, wait, execute | Emits `OwnerAdded`, updates `isOwner[extraOwner] = true`, increases `getOwners().length` to `4` | **PASS** |
| **T18b** | Full governance flow for `changeDelay(120)` and `changeThreshold(3)` | Emits `DelayChanged(120)` and `ThresholdChanged(3)`, updates state variables | **PASS** |
| **T18c** | Full governance flow for `removeOwner(owner3)` (from 4 owners down to 3) | Emits `OwnerRemoved`, sets `isOwner[owner3] = false`; `owner3` calling `submit()` reverts `NotOwner` | **PASS** |
| **T19** | Proposal to `changeThreshold(5)` (above owner count) executed after delay | Inner self-call fails; `execute(0)` reverts with `ExecutionFailed` and status remains `Queued` (`2`) | **PASS** |
| **T20** | Reentrancy attack via `ReentrancyAttacker.sol` during `execute(0)` | Inner reentrant call fails (`reentrantCallSucceeded == false`); wallet loses only the intended `1.0 ETH` | **PASS** |
| **T21** | `execute(0)` when `value` exceeds wallet ETH balance | Reverts with custom error `InsufficientBalance` | **PASS** |
| **T22** | After `removeOwner`, a `Queued` tx whose active approvals fell below threshold is executed / synced | `execute()` reverts `NotApproved`; calling `sync()` demotes status to `Pending` and clears `unlockTime` | **PASS** |
| **T23** | Edge checks: `submit` to `address(0)`, invalid `id = 99`, 3rd approval on `Queued` tx | `address(0)` reverts `InvalidOwner`; `id = 99` reverts `TxNotFound`; 3rd approval keeps original `unlockTime` | **PASS** |

---

## 3. Code Coverage Report (`solidity-coverage v0.8.17`)

```text
-----------------------------|----------|----------|----------|----------|----------------|
File                         |  % Stmts | % Branch |  % Funcs |  % Lines |Uncovered Lines |
-----------------------------|----------|----------|----------|----------|----------------|
 contracts\                  |      100 |    76.52 |      100 |    99.25 |                |
  MultiSigTimelockWallet.sol |      100 |    76.52 |      100 |    99.25 |            362 |
 contracts\test\             |      100 |      100 |      100 |      100 |                |
  ReentrancyAttacker.sol     |      100 |      100 |      100 |      100 |                |
-----------------------------|----------|----------|----------|----------|----------------|
All files                    |      100 |    76.52 |      100 |    99.28 |                |
-----------------------------|----------|----------|----------|----------|----------------|
```

---

## 4. Real Gas Consumption Table (`REPORT_GAS=true npx hardhat test`)

Measured with `Solc 0.8.20` (Optimizer enabled, `200` runs, block gas limit `60,000,000`):

| Contract / Method | Min Gas | Max Gas | Avg Gas | # Calls / % Limit |
| :--- | ---: | ---: | ---: | ---: |
| `MultiSigTimelockWallet` (Deployment) | — | — | **2,112,034** | 3.5% of limit |
| `ReentrancyAttacker` (Deployment) | — | — | **203,042** | 0.3% of limit |
| `submit` | 174,843 | 237,491 | **203,322** | 26 calls |
| `approve` | 52,485 | 102,374 | **96,416** | 25 calls |
| `execute` | 75,224 | 119,516 | **92,378** | 15 calls |
| `voteCancel` | 35,147 | 76,092 | **60,159** | 6 calls |
| `revoke` | 47,073 | 50,235 | **49,445** | 4 calls |
| `sync` | — | — | **47,629** | 1 call |

---

## 5. Evidence Screenshots & Negative-Case Proof

- **Screenshot 1 — `npx hardhat test` + Gas Table Terminal Output**:  
  `[PLACEHOLDER: Insert screenshot of npx hardhat test showing 28 passing tests and gas table]`
- **Screenshot 2 — `npx hardhat coverage` Table Output**:  
  `[PLACEHOLDER: Insert screenshot of npx hardhat coverage showing 100% Stmts / 99.25% Lines]`
- **Screenshot 3 — `npx hardhat run scripts/demo.js` Output (Includes `NotQueued` & `TooEarly` Negative Reverts)**:  
  `[PLACEHOLDER: Insert screenshot of scripts/demo.js terminal walkthrough]`
- **Screenshot 4 — Live Negative-Case UI Proof (Wrong Network Banner / Non-Owner Read-Only / Disabled Execute During Countdown)**:  
  `[PLACEHOLDER: Insert screenshot showing rejected or disabled negative action on the Sepolia dashboard]`
