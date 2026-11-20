# System Design Document — MultiSigTimelockWallet

---

## 1. System Architecture Diagram

The system uses a three-tier Web3 architecture: owners interact with the browser dashboard through MetaMask, while `MultiSigTimelockWallet` on the Ethereum Sepolia Testnet enforces all consensus and time-lock rules on-chain.

```mermaid
flowchart LR
    subgraph Users["Wallet Signatories & Observers"]
        O1["Owner 1 (MetaMask)"]
        O2["Owner 2 (MetaMask)"]
        O3["Owner 3 (MetaMask)"]
        PY["Python CLI (web3.py)"]
    end

    subgraph Frontend["Frontend dApp (No Build Step)"]
        UI["HTML5 / CSS3 / app.js\n+ Ethers v6 CDN"]
    end

    subgraph Blockchain["Ethereum Sepolia / Hardhat EVM"]
        subgraph Contract["MultiSigTimelockWallet.sol"]
            MOD["Modifiers: onlyOwner, onlySelf, nonReentrant"]
            APP["Dynamic Vote Counter (_approvalCount / _cancelCount)"]
            TL["Time-Lock & 7-Day Grace Window"]
            GOV["Self-Governance (add/removeOwner, changeThreshold/Delay)"]
        end
        REC["Recipient EOA or External Contract"]
    end

    O1 & O2 & O3 -->|Sign Tx| UI
    UI -->|JSON-RPC Calls & Events| Contract
    PY -->|Read-Only RPC| Contract
    Contract -->|".call{value}(data) after delay"| REC
    Contract -->|Internal self-call| GOV
```

---

## 2. Use-Case Diagram

```mermaid
flowchart TB
    Owner(["👤 Active Wallet Owner"])
    Proposer(["👤 Proposer (Owner who submitted Tx)"])
    Self(["🔐 Wallet Contract (onlySelf)"])
    Observer(["👀 Outside Observer / Recipient"])

    subgraph WalletUseCases["MultiSigTimelockWallet Use Cases"]
        UC1("Submit Proposal (Auto-Approves)")
        UC2("Approve Proposal (Queues at M approvals)")
        UC3("Revoke Approval (Demotes to Pending if < M)")
        UC4("Execute Queued Proposal (After Delay, Within 7d Grace)")
        UC5("Cancel Immediately (Proposer)")
        UC6("Vote to Cancel (Cancels at M votes)")
        UC7("Deposit ETH (receive)")
        UC8("Inspect Transactions & Sync Stale Status")
        UC9("Modify Owners / Threshold / Delay")
    end

    Owner --> UC1
    Owner --> UC2
    Owner --> UC3
    Owner --> UC4
    Owner --> UC6
    Proposer --> UC5
    Observer --> UC7
    Observer --> UC8
    Self --> UC9
```

---

## 3. Transaction State Machine Diagram

Note that `Expired` (`5`) is **not** written to storage; it is computed dynamically by `isExpired(id)` and `getStatus(id)` whenever `status == Status.Queued` and `block.timestamp > unlockTime + GRACE_PERIOD`.

```mermaid
stateDiagram-v2
    [*] --> Pending : submit() by Owner\n(Proposer auto-approved: 1/M)

    Pending --> Queued : approve() reaches threshold M\n(unlockTime = now + delay)
    Queued --> Pending : revoke() or sync() drops active approvals < M\n(unlockTime = 0)

    Pending --> Cancelled : voteCancel() by Proposer\nor M non-proposer cancel votes
    Queued --> Cancelled : voteCancel() by Proposer\nor M non-proposer cancel votes

    Queued --> Executed : execute() when\nunlockTime <= now <= unlockTime + 7 days
    Queued --> Expired_Derived : Derived when\nnow > unlockTime + 7 days (GRACE_PERIOD)

    Executed --> [*]
    Cancelled --> [*]
    Expired_Derived --> [*]
```

---

## 4. Sequence Diagram — Propose, Approve, Wait, Execute

```mermaid
sequenceDiagram
    autonumber
    actor O1 as Owner 1 (Proposer)
    actor O2 as Owner 2 (Approver)
    participant W as MultiSigTimelockWallet
    actor R as Recipient

    O1->>W: submit(Recipient, 0.1 ETH, "0x", "Lab payout")
    Note over W: txCount = 1, id = 0<br/>status = Pending (1)<br/>approved[0][O1] = true (1/2)
    W-->>O1: emit Submitted(0, ...) & Approved(0, O1)

    O2->>W: approve(0)
    Note over W: approved[0][O2] = true (2/2 >= threshold)<br/>status = Queued (2)<br/>unlockTime = block.timestamp + 60s
    W-->>O2: emit Approved(0, O2) & Queued(0, unlockTime)

    O1->>W: execute(0) [After 20s — Too Early]
    W--xO1: revert TooEarly()

    Note over O1,W: Wait until block.timestamp >= unlockTime (60s elapsed)

    O1->>W: execute(0)
    Note over W: Verify Queued, approvals >= 2,<br/>now >= unlockTime, now <= unlockTime + 7d,<br/>status = Executed BEFORE external call
    W->>R:Recipient.call{value: 0.1 ETH}("")
    R-->>W: success (ok = true)
    W-->>O1: emit Executed(0, O1, Recipient, 0.1 ETH, "0x")
```

---

## 5. EVM Storage Layout Table

| Slot / Variable | Solidity Type | Visibility | Description |
| :--- | :--- | :--- | :--- |
| `MAX_OWNERS` | `uint256 constant` | `public` | Constant (`10`) embedded in bytecode (no storage slot). |
| `GRACE_PERIOD` | `uint256 constant` | `public` | Constant (`7 days = 604800`) embedded in bytecode. |
| `MIN_DELAY` | `uint256 constant` | `public` | Constant (`10 seconds`) embedded in bytecode. |
| `MAX_DELAY` | `uint256 constant` | `public` | Constant (`30 days = 2592000`) embedded in bytecode. |
| Slot 0: `owners` | `address[]` | `public` | Dynamic array of active owner addresses (length $3 \dots 10$). |
| Slot 1: `isOwner` | `mapping(address => bool)` | `public` | $O(1)$ lookup table for active owner membership. |
| Slot 2: `threshold` | `uint256` | `public` | Required number of active owner approvals ($M$). |
| Slot 3: `delay` | `uint256` | `public` | Time-lock duration in seconds before a queued tx unlocks. |
| Slot 4: `txCount` | `uint256` | `public` | Monotonically increasing counter of submitted transactions. |
| Slot 5: `transactions` | `mapping(uint256 => Tx)` | `public` | Maps transaction ID to `Tx` struct (`to`, `value`, `data`, `note`, `proposer`, `unlockTime`, `status`). |
| Slot 6: `approved` | `mapping(uint256 => mapping(address => bool))` | `public` | Tracks whether a given address has approved transaction `id`. |
| Slot 7: `cancelVoted` | `mapping(uint256 => mapping(address => bool))` | `public` | Tracks whether a non-proposer owner voted to cancel transaction `id`. |
| Slot 8: `_locked` | `bool` | `private` | Reentrancy mutex lock used by the `nonReentrant` modifier. |

---

## 6. Complete Function Specification Table

| Function | Who Can Call | State Changes | Events Emitted |
| :--- | :--- | :--- | :--- |
| `constructor(owners_, threshold_, delay_)` | Deployer (once) | Sets `owners`, `isOwner`, `threshold`, `delay` | *(None)* |
| `receive()` | Anyone | Increases contract ETH balance | `Deposited(sender, amount, balanceAfter)` |
| `submit(to, value, data, note)` | `onlyOwner` | Increments `txCount`, stores `Tx` as `Pending`, sets `approved[id][msg.sender] = true` | `Submitted`, `Approved` |
| `approve(id)` | `onlyOwner` | Sets `approved[id][msg.sender] = true`; if `Pending` and approvals $\ge$ `threshold`, sets `Queued` and `unlockTime` | `Approved`, `Queued` *(if threshold reached)* |
| `revoke(id)` | `onlyOwner` | Sets `approved[id][msg.sender] = false`; if `Queued` and approvals $<$ `threshold`, sets `Pending` and `unlockTime = 0` | `Revoked` |
| `sync(id)` | Anyone | If `Queued` and active approvals $<$ `threshold`, sets `Pending` and `unlockTime = 0` | *(None)* |
| `execute(id)` | `onlyOwner` (`nonReentrant`) | Sets `status = Executed`, transfers ETH / runs calldata on `to` | `Executed` *(plus any inner governance event)* |
| `voteCancel(id)` | `onlyOwner` | Records `cancelVoted[id][msg.sender] = true` (if not proposer); sets `status = Cancelled` and `unlockTime = 0` if proposer or votes $\ge$ `threshold` | `Cancelled` *(when cancelled)* |
| `addOwner(newOwner)` | `onlySelf` | Sets `isOwner[newOwner] = true`, pushes to `owners` | `OwnerAdded(newOwner)` |
| `removeOwner(ownerToRemove)` | `onlySelf` | Sets `isOwner[ownerToRemove] = false`, swap-and-pops from `owners` | `OwnerRemoved(ownerToRemove)` |
| `changeThreshold(newThreshold)` | `onlySelf` | Updates `threshold = newThreshold` | `ThresholdChanged(newThreshold)` |
| `changeDelay(newDelay)` | `onlySelf` | Updates `delay = newDelay` | `DelayChanged(newDelay)` |
| `getOwners()`, `getTransaction(id)`, `getStatus(id)`, `timeLeft(id)`, `isExpired(id)`, `approvalCount(id)`, `cancelCount(id)` | Anyone (`view`) | Read-only (no state change) | *(None)* |
