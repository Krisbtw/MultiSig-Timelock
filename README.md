# Multi-Signature Wallet with Time-Locked Transaction Execution

A complete, beginner-friendly **Blockchain Technology Lab Mini Project (Experiment 10)** built with **Solidity `^0.8.20`**, **Hardhat**, **Ethers v6**, **MetaMask**, and **Python (`web3.py`)**.

## Team Members
- `Kris Rodrigues (Roll No: 2414035)`
- `Krisha Shet (Roll No: 2414036)`
- `Student Signatory (Roll No: 2414037)`
- `Student Signatory (Roll No: 2414038)`
- **Sepolia Contract Address**: `0xFA40A3218bD6e1240331b556Ae9dE56e1aF22B0D`
- **Sepolia Etherscan Link**: `https://sepolia.etherscan.io/address/0xFA40A3218bD6e1240331b556Ae9dE56e1aF22B0D`

---

## 1. Overview & Key Features

`MultiSigTimelockWallet` holds ETH and executes transactions only after **two independent security layers** are satisfied:
1. **$M$-of-$N$ Multi-Signature Approvals**: Requires between `3` and `10` unique owners (`MAX_OWNERS = 10`) and an approval threshold `2 <= threshold <= owners.length`.
2. **Mandatory Time-Lock Delay (`10s` to `30 days`)**: The countdown (`unlockTime = block.timestamp + delay`) starts **only** when the approval count first reaches `threshold` (`Status.Queued`).
3. **7-Day Expiry Grace Window (`GRACE_PERIOD = 7 days`)**: Unexecuted queued transactions expire 7 days after `unlockTime` (derived status `5`), preventing stale proposals from executing months later.
4. **Revocation & Timer Reset**: Any approving owner can call `revoke(id)` before execution. If active approvals drop below `threshold`, the proposal returns to `Pending` and `unlockTime` resets to `0`.
5. **Dual Cancellation (`voteCancel`)**: The original proposer can cancel immediately, or `threshold` non-proposer owners can vote to cancel a suspicious proposal.
6. **Self-Governance (`onlySelf`)**: Adding/removing owners (`addOwner`, `removeOwner`) and updating `threshold` or `delay` (`changeThreshold`, `changeDelay`) can only run through an executed time-locked proposal targeting the wallet itself.
7. **Zero External Imports (Remix-Ready)**: `contracts/MultiSigTimelockWallet.sol` is a single standalone file with a custom `nonReentrant` guard, NatSpec comments, and 15 custom errors.

---

## 2. Repository Folder Structure

```text
multisig-timelock-wallet/
├── contracts/
│   ├── MultiSigTimelockWallet.sol        # Standalone Solidity ^0.8.20 contract (Remix & Hardhat ready)
│   └── test/
│       └── ReentrancyAttacker.sol        # Malicious contract used in T20 reentrancy test
├── test/
│   └── MultiSigTimelockWallet.test.js    # 28 automated unit & adversarial tests (T1 to T23)
├── scripts/
│   ├── deploy.js                         # Deploys wallet and writes frontend/abi.json & config.json
│   └── demo.js                           # 11-step local end-to-end story with time travel
├── frontend/
│   ├── index.html                        # Single-page Web3 dashboard (no build step)
│   ├── style.css                         # Responsive layout and colour-coded status badges
│   ├── app.js                            # MetaMask + Ethers v6 logic, countdowns, error decoding
│   ├── abi.json                          # Generated contract ABI
│   └── config.json                       # Generated contract address & network metadata
├── python/
│   ├── list_pending.py                   # Read-only web3.py CLI transaction table inspector
│   └── requirements.txt                  # Python dependencies (web3, python-dotenv, tabulate)
├── docs/
│   ├── PROJECT_CONTEXT.md                # Frozen technical specification
│   ├── SRS.md                            # Software Requirements Specification (FR1–FR12)
│   ├── DESIGN.md                         # Mermaid diagrams, storage layout & function table
│   ├── SECURITY_ANALYSIS.md              # 11-item security audit & honest limitations
│   └── TEST_REPORT.md                    # T1–T23 results & code coverage report
├── .env.example                          # Template for SEPOLIA_RPC_URL, PRIVATE_KEY, OWNERS, etc.
├── .gitignore                            # Ignores node_modules, .env, cache, artifacts, coverage
├── hardhat.config.js                     # Solidity 0.8.20 (optimizer 200 runs), localhost & sepolia
├── package.json                          # NPM scripts & Hardhat dependencies
└── README.md                             # Project overview and usage instructions
```

---

## 3. Installation & Setup

```bash
cd multisig-timelock-wallet
npm install
cp .env.example .env
```

---

## 4. Compile, Run Tests, Coverage & Local Demo

```bash
# 1. Compile smart contracts (0 warnings)
npx hardhat compile

# 2. Run all 28 automated tests (T1 to T23)
npx hardhat test

# 3. Run code coverage report (>96% branch, 100% line coverage)
npx hardhat coverage

# 4. Run the 11-step interactive local demo script
npx hardhat run scripts/demo.js
```

---

## 5. Deploying to Localhost or Sepolia Testnet

Deploy to a local Hardhat node or to the Ethereum Sepolia Testnet using Hardhat:

```bash
# Option A: Local Hardhat node
npx hardhat node
npx hardhat run scripts/deploy.js --network localhost

# Option B: Ethereum Sepolia Testnet (after filling .env)
npx hardhat run scripts/deploy.js --network sepolia
```

---

## 6. Running the Frontend Dashboard

The frontend uses plain HTML, CSS, and Ethers v6 from a CDN with **no build step**:

```bash
npx serve frontend
```

Open `http://localhost:3000` in your browser with MetaMask installed.

### Manual Frontend Test Checklist
- [ ] Click **Connect MetaMask** -> Connected account and network badge appear.
- [ ] Switch MetaMask to a non-Sepolia/non-Localhost chain -> Red network warning banner and **Switch to Sepolia** button appear.
- [ ] Switch to an Owner account -> Summary cards show ETH balance, `2 of 3` threshold, `1m 0s (60s)` delay, and `You (Owner)` badge.
- [ ] Switch to a Non-Owner account -> Yellow read-only banner appears and proposal buttons are disabled.
- [ ] Deposit `0.05 ETH` -> Toast shows Etherscan link, balance rises, `Deposited` appears in Activity Feed.
- [ ] Submit a `0.01 ETH` proposal as Owner 1 -> Row `#0` appears as `Pending (1/2)`, Owner 1's `Approve` button is disabled with tooltip.
- [ ] Switch to Owner 2 and click **Approve** -> Row `#0` becomes `Queued (2/2)` and the 60s countdown ticks down every second.
- [ ] Click **Revoke** as Owner 2 -> Row `#0` returns to `Pending (1/2)` and timer clears.
- [ ] Re-approve as Owner 2, wait 60s for countdown to hit `0s (Unlocked)`, and click **Execute** -> Status becomes `Executed` and recipient receives `0.01 ETH`.

---

## 7. Optional Python Inspector (`web3.py`)

```bash
pip install -r python/requirements.txt
python3 python/list_pending.py
```

Reads `SEPOLIA_RPC_URL` from `.env` and `frontend/config.json` + `frontend/abi.json` to print a read-only table of all proposals (`ID`, `Recipient`, `Amount`, `Approvals`, `Status`, `Seconds to Unlock`, `Note`).

---

## 8. Known Limitations

1. **Re-Added Owner Historical Flags**: Because `approved[id][owner]` and `cancelVoted[id][owner]` are stored in nested mappings, if an owner is removed via `removeOwner` and that **exact same address** is later re-added via `addOwner` while an old transaction `id` is still active, their previous `true` flag on that old transaction `id` counts again.
2. **Lost Private Keys**: If more than `N - M` owners lose their private keys, the remaining owners cannot reach `threshold` and funds remain locked.
3. **On-Chain Voting Gas**: Every approval and cancellation vote is an on-chain transaction.
