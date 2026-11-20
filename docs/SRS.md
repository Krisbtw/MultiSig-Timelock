# Software Requirements Specification (SRS)
## Multi-Signature Wallet with Time-Locked Transaction Execution

---

## 1. Purpose and Scope

This Software Requirements Specification (SRS) defines the functional and non-functional requirements for **MultiSigTimelockWallet**, a smart-contract wallet on the Ethereum Virtual Machine (EVM) accompanied by a MetaMask web dashboard and a read-only Python CLI inspector. The system protects shared ETH treasuries by requiring $M$-of-$N$ owner approvals followed by a mandatory time-lock delay before execution.

---

## 2. System Actors

| Actor | Role Description | Permissions in Contract |
| :--- | :--- | :--- |
| **Wallet Owner (Signatory)** | One of the 3 to 10 addresses stored in `owners` (`isOwner[addr] == true`). | Can call `submit`, `approve`, `revoke`, `execute`, `voteCancel`, `sync`, and deposit ETH. |
| **Proposer** | The specific Wallet Owner who submitted a given transaction `id` (`transactions[id].proposer`). | Automatically approves on submission; can cancel their own `Pending` or `Queued` transaction immediately via `voteCancel(id)`. |
| **Wallet Self (`address(this)`)** | The wallet contract itself acting during `execute(id)` when `txn.to == address(this)`. | Sole caller allowed to invoke `addOwner`, `removeOwner`, `changeThreshold`, and `changeDelay` (`onlySelf`). |
| **Recipient** | Any external user address (EOA) or smart contract that receives ETH or calldata when a proposal is executed. | Can deposit ETH (`receive()`) and view public state; cannot propose, approve, or execute. |
| **Outside Observer / Auditor** | Any non-owner user, block explorer, or the Python `list_pending.py` script. | Can read all public views (`getOwners`, `getTransaction`, `getStatus`, `timeLeft`, `isExpired`) and call `sync(id)` or deposit ETH. |

---

## 3. Functional Requirements (FR1 to FR12)

Every functional requirement maps directly to functions, modifiers, events, and custom errors in `contracts/MultiSigTimelockWallet.sol`.

| ID | Requirement Title | Detailed Description | Mapped Contract Functions / Errors |
| :- | :--- | :--- | :--- |
| **FR1** | **Multi-Owner Initialization** | The constructor must accept 3 to 10 unique non-zero owner addresses, a threshold $M$ ($2 \le M \le N$), and a delay between 10 seconds and 30 days. Invalid inputs must revert immediately. | `constructor(owners_, threshold_, delay_)`<br>Errors: `InvalidOwner`, `InvalidThreshold`, `InvalidDelay` |
| **FR2** | **ETH Deposits** | The wallet must accept plain ETH transfers from any address and emit an event logging the sender, amount, and updated wallet balance. | `receive() external payable`<br>Event: `Deposited` |
| **FR3** | **Transaction Proposal Submission** | Any active owner must be able to submit a proposal (`to`, `value`, `data`, `note`) where `to != address(0)`. The proposal starts as `Pending` and automatically records the proposer's approval. | `submit(to, value, data, note)`<br>Events: `Submitted`, `Approved`<br>Errors: `NotOwner`, `InvalidOwner` |
| **FR4** | **Owner Approval & Time-Lock Queueing** | Active owners must be able to approve a `Pending` or `Queued` proposal once. When active approvals reach `threshold` while `Pending`, status transitions to `Queued` and `unlockTime = block.timestamp + delay`. | `approve(id)`, `_approvalCount(id)`<br>Events: `Approved`, `Queued`<br>Errors: `TxNotFound`, `InvalidStatus`, `AlreadyApproved` |
| **FR5** | **Approval Revocation & Timer Reset** | An owner who has approved a `Pending` or `Queued` proposal must be able to revoke their approval. If active approvals on a `Queued` proposal drop below `threshold`, status returns to `Pending` and `unlockTime` resets to `0`. | `revoke(id)`<br>Event: `Revoked`<br>Errors: `NotApproved`, `InvalidStatus` |
| **FR6** | **State Synchronization After Governance** | Anyone must be able to demote a `Queued` transaction back to `Pending` (clearing `unlockTime`) if owner removal or a threshold increase caused active approvals to drop below `threshold`. | `sync(id)`<br>Error: `TxNotFound` |
| **FR7** | **Time-Locked Execution** | Any active owner must be able to execute a `Queued` proposal once `block.timestamp >= unlockTime`, provided `block.timestamp <= unlockTime + GRACE_PERIOD`, `_approvalCount(id) >= threshold`, and `address(this).balance >= value`. | `execute(id)`<br>Event: `Executed`<br>Errors: `NotQueued`, `NotApproved`, `TooEarly`, `Expired`, `InsufficientBalance`, `ExecutionFailed` |
| **FR8** | **Transaction Expiry After Grace Period** | A `Queued` proposal not executed within 7 days (`GRACE_PERIOD`) after `unlockTime` must be treated as `Expired` (status code `5`) and blocked from execution. | `isExpired(id)`, `getStatus(id)`, `execute(id)`<br>Error: `Expired` |
| **FR9** | **Emergency Cancellation** | A `Pending` or `Queued` proposal must be cancellable either immediately by its `proposer` or when `threshold` active owners cast cancellation votes. | `voteCancel(id)`, `_cancelCount(id)`<br>Event: `Cancelled`<br>Errors: `InvalidStatus`, `AlreadyApproved` |
| **FR10** | **Self-Governed Owner & Parameter Updates** | Adding/removing owners and changing `threshold` or `delay` must only succeed when called by the wallet contract itself (`onlySelf`) via an executed time-locked proposal. | `addOwner`, `removeOwner`, `changeThreshold`, `changeDelay`<br>Events: `OwnerAdded`, `OwnerRemoved`, `ThresholdChanged`, `DelayChanged`<br>Error: `NotSelf` |
| **FR11** | **Frontend Web3 Dashboard** | A browser dashboard must connect to MetaMask, display wallet KPIs, build standard and governance proposals, show a live 1-second unlock countdown, and decode custom errors into friendly messages. | `frontend/index.html`, `frontend/style.css`, `frontend/app.js` |
| **FR12** | **Read-Only CLI Inspection** | Users and scripts must be able to query all owners, transaction details, dynamic approval/cancel counts, status codes, and remaining unlock seconds without spending gas or using a private key. | `getOwners`, `getTransaction`, `getStatus`, `timeLeft`, `approvalCount`, `cancelCount`, `python/list_pending.py` |

---

## 4. Non-Functional Requirements

1. **Security (NFR1)**:
   - Must prevent reentrancy attacks using both Checks-Effects-Interactions (`status = Status.Executed` before `.call`) and a custom `nonReentrant` lock.
   - Must dynamically compute approval and cancel-vote counts over the active `owners` array so removed owners' prior votes never count.
2. **Gas & Loop Boundedness (NFR2)**:
   - All loops in the contract must be strictly bounded by `MAX_OWNERS = 10` so no function can ever fail due to block gas exhaustion.
   - Must use Solidity `^0.8.20` custom errors instead of long `require` revert strings to reduce deployment and runtime gas costs.
3. **Portability & Auditability (NFR3)**:
   - `contracts/MultiSigTimelockWallet.sol` must have zero external `import` statements so students and evaluators can paste it directly into Remix IDE and compile with zero warnings.
4. **Usability (NFR4)**:
   - Action buttons in the dashboard must be dynamically enabled/disabled based on the connected MetaMask account and on-chain state, with hover tooltips explaining why any button is disabled.

---

## 5. Assumptions and Constraints

- **Assumptions**:
  - Owners use a Web3-compatible browser wallet (MetaMask) connected to the Ethereum Sepolia Testnet (`chainId: 11155111`) or a local Hardhat node (`chainId: 31337`).
  - At least $M$ of the $N$ owners retain access to their private keys.
- **Constraints**:
  - Minimum owners: `3`; maximum owners: `10`.
  - Minimum approval threshold: `2`; maximum threshold: `owners.length`.
  - Minimum time-lock delay: `10 seconds`; maximum delay: `30 days`; execution grace period: `7 days`.
