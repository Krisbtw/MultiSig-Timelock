/**
 * MultiSigTimelockWallet — Frontend Controller (app.js)
 * Plain JavaScript + Ethers v6 (CDN). Zero build step required.
 */

const SEPOLIA_CHAIN_ID = 11155111n;
const LOCALHOST_CHAIN_ID = 31337n;

// Human-readable messages for every custom error in MultiSigTimelockWallet.sol
const FRIENDLY_ERRORS = {
  NotOwner: "Only an active wallet signatory can perform this action.",
  NotSelf: "Governance functions can only run through an executed wallet proposal.",
  TxNotFound: "That transaction ID does not exist.",
  AlreadyApproved: "You have already approved (or voted to cancel) this transaction.",
  NotApproved: "Not enough active owner approvals, or you have not approved this transaction.",
  NotQueued: "This transaction is not in the Queued state.",
  TooEarly: "The timelock has not finished yet. Wait until the countdown reaches 0s.",
  Expired: "This transaction expired (more than 7 days passed after unlock).",
  InvalidThreshold: "Invalid threshold: must be between 2 and the current owner count.",
  InvalidOwner: "Invalid owner address (zero address, duplicate, or owner count outside 3..10).",
  InvalidDelay: "Invalid delay: must be between 10 seconds and 30 days.",
  InvalidStatus: "This action is not allowed in the transaction's current status.",
  ExecutionFailed: "The target call reverted during execution.",
  InsufficientBalance: "The wallet does not hold enough ETH to execute this transfer.",
  Reentrancy: "Reentrant call blocked by the nonReentrant guard.",
};

const STATUS_META = {
  1: { label: "Pending", css: "status-1" },
  2: { label: "Queued", css: "status-2" },
  3: { label: "Executed", css: "status-3" },
  4: { label: "Cancelled", css: "status-4" },
  5: { label: "Expired", css: "status-5" },
};

const GOVERNANCE_EVENTS = new Set([
  "OwnerAdded",
  "OwnerRemoved",
  "ThresholdChanged",
  "DelayChanged",
]);

// Application state
let provider = null;
let signer = null;
let connectedAccount = null;
let contract = null;
let contractAbi = null;
let appConfig = null;
let cachedBalanceWei = 0n;
let cachedTransactions = [];
let cachedFeedItems = [];
let countdownInterval = null;

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatDuration(sec) {
  const s = Number(sec);
  if (s <= 0) return "Unlocked";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (rem > 0 || parts.length === 0) parts.push(`${rem}s`);
  return parts.join(" ");
}

function showToast(message, type = "info", txHash = null) {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;

  let html = `<div>${escapeHtml(message)}</div>`;
  if (
    txHash &&
    appConfig &&
    appConfig.etherscanBaseUrl &&
    appConfig.etherscanBaseUrl.startsWith("https://")
  ) {
    const url = `${appConfig.etherscanBaseUrl}/tx/${txHash}`;
    html += `<a href="${url}" target="_blank" rel="noopener noreferrer">View transaction on Etherscan</a>`;
  }
  el.innerHTML = html;
  container.appendChild(el);

  setTimeout(() => {
    el.remove();
  }, 6500);
}

function decodeContractError(err) {
  if (!err) return "Unknown error";

  const data = err.data || (err.info && err.info.error && err.info.error.data);
  if (data && contract && contract.interface) {
    try {
      const parsed = contract.interface.parseError(data);
      if (parsed && FRIENDLY_ERRORS[parsed.name]) {
        return `${parsed.name}: ${FRIENDLY_ERRORS[parsed.name]}`;
      }
      if (parsed) return `Reverted with ${parsed.name}`;
    } catch (_) {
      // Fall through to string matching
    }
  }

  const msg = err.shortMessage || err.reason || err.message || String(err);
  for (const [errName, friendly] of Object.entries(FRIENDLY_ERRORS)) {
    if (msg.includes(errName)) {
      return `${errName}: ${friendly}`;
    }
  }
  if (msg.includes("user rejected") || err.code === "ACTION_REJECTED") {
    return "Transaction rejected in MetaMask.";
  }
  return msg;
}

async function initConfigAndAbi() {
  try {
    const [cfgRes, abiRes] = await Promise.all([fetch("./config.json"), fetch("./abi.json")]);
    appConfig = await cfgRes.json();
    contractAbi = await abiRes.json();

    const input = document.getElementById("contractAddrInput");
    if (appConfig && appConfig.contractAddress) {
      input.value = appConfig.contractAddress;
    }
  } catch (err) {
    showToast("Could not load config.json or abi.json. Run scripts/deploy.js first.", "error");
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    showToast("MetaMask is not installed. Please install the MetaMask extension.", "error");
    return;
  }

  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    connectedAccount = await signer.getAddress();

    document.getElementById("accountBadge").textContent = shortAddr(connectedAccount);
    document.getElementById("connectBtn").textContent = "Connected";

    await checkNetwork();
    await bindContractAndRefresh();
  } catch (err) {
    showToast(decodeContractError(err), "error");
  }
}

async function checkNetwork() {
  if (!provider) return;
  const net = await provider.getNetwork();
  const chainId = net.chainId;
  const badge = document.getElementById("networkBadge");
  const banner = document.getElementById("networkBanner");

  if (chainId === SEPOLIA_CHAIN_ID) {
    badge.textContent = "Sepolia";
    banner.classList.add("hidden");
  } else if (chainId === LOCALHOST_CHAIN_ID) {
    badge.textContent = "Localhost 31337";
    banner.classList.add("hidden");
  } else {
    badge.textContent = `Chain ${chainId}`;
    document.getElementById("wrongNetName").textContent = `${net.name} (${chainId})`;
    banner.classList.remove("hidden");
  }
}

async function switchToSepolia() {
  if (!window.ethereum) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
  } catch (err) {
    showToast("Could not switch network automatically. Select Sepolia in MetaMask.", "error");
  }
}

async function bindContractAndRefresh() {
  const addr = document.getElementById("contractAddrInput").value.trim();
  if (!ethers.isAddress(addr)) {
    showToast("Enter a valid 0x contract address.", "error");
    return;
  }
  if (!contractAbi || !provider) return;

  if (contract) {
    contract.removeAllListeners();
  }

  contract = new ethers.Contract(addr, contractAbi, signer || provider);

  const eventNames = [
    "Deposited",
    "Submitted",
    "Approved",
    "Revoked",
    "Queued",
    "Executed",
    "Cancelled",
    "OwnerAdded",
    "OwnerRemoved",
    "ThresholdChanged",
    "DelayChanged",
  ];
  for (const ev of eventNames) {
    contract.on(ev, () => {
      refreshDashboard();
    });
  }

  await refreshDashboard();
}

async function refreshDashboard() {
  if (!contract || !provider) return;

  try {
    const addr = await contract.getAddress();
    const [bal, thresh, del, owners, txCount] = await Promise.all([
      provider.getBalance(addr),
      contract.threshold(),
      contract.delay(),
      contract.getOwners(),
      contract.txCount(),
    ]);

    cachedBalanceWei = bal;

    document.getElementById("walletBalance").textContent = `${Number(ethers.formatEther(bal)).toFixed(4)} ETH`;
    document.getElementById("walletThreshold").textContent = `${thresh} of ${owners.length}`;
    document.getElementById("ownersCountSub").textContent = `${owners.length} active signatories (max 10)`;
    document.getElementById("walletDelay").textContent = `${formatDuration(del)} (${del}s)`;

    const isConnectedOwner =
      connectedAccount &&
      owners.some((o) => o.toLowerCase() === connectedAccount.toLowerCase());

    const roleBadge = document.getElementById("roleBadge");
    roleBadge.classList.remove("hidden", "pill-owner", "pill-non-owner");
    if (isConnectedOwner) {
      roleBadge.textContent = "Owner";
      roleBadge.classList.add("pill-owner");
    } else {
      roleBadge.textContent = "Read-Only";
      roleBadge.classList.add("pill-non-owner");
    }

    document.getElementById("nonOwnerBanner").classList.toggle("hidden", Boolean(isConnectedOwner));
    document.getElementById("proposeSubmitBtn").disabled = !isConnectedOwner;
    document.getElementById("govSubmitBtn").disabled = !isConnectedOwner;

    const ownersListEl = document.getElementById("ownersList");
    ownersListEl.innerHTML = "";
    for (const ownerAddr of owners) {
      const li = document.createElement("li");
      const isMe =
        connectedAccount && ownerAddr.toLowerCase() === connectedAccount.toLowerCase();
      li.innerHTML = `
        <span title="${ownerAddr}">${ownerAddr}</span>
        ${isMe ? '<span class="you-tag">Connected</span>' : ""}
      `;
      ownersListEl.appendChild(li);
    }

    const countNum = Number(txCount);
    const txItems = [];
    let pendingCnt = 0;
    let queuedCnt = 0;

    for (let id = countNum - 1; id >= 0; id--) {
      const [txData, statusVal, remSec, myApproved, myCancelVoted, ownerApprovalFlags] =
        await Promise.all([
          contract.getTransaction(id),
          contract.getStatus(id),
          contract.timeLeft(id),
          connectedAccount ? contract.approved(id, connectedAccount) : false,
          connectedAccount ? contract.cancelVoted(id, connectedAccount) : false,
          Promise.all(owners.map((o) => contract.approved(id, o))),
        ]);

      const approverAddresses = owners.filter((_, idx) => Boolean(ownerApprovalFlags[idx]));
      const statusNum = Number(statusVal);
      if (statusNum === 1) pendingCnt++;
      if (statusNum === 2) queuedCnt++;

      txItems.push({
        id,
        to: txData.to,
        value: txData.value,
        data: txData.data,
        note: txData.note,
        proposer: txData.proposer,
        unlockTime: Number(txData.unlockTime),
        status: statusNum,
        approvals: Number(txData.approvals),
        cancelVotes: Number(txData.cancelVotes),
        timeLeft: Number(remSec),
        fetchedAtSec: Math.floor(Date.now() / 1000),
        myApproved: Boolean(myApproved),
        myCancelVoted: Boolean(myCancelVoted),
        approverAddresses,
      });
    }

    document.getElementById("pendingCountValue").textContent = String(pendingCnt + queuedCnt);
    document.getElementById("pendingCountSub").textContent = `${pendingCnt} Pending · ${queuedCnt} Queued`;

    cachedTransactions = txItems;
    renderTransactionsTable(txItems, Number(thresh), Boolean(isConnectedOwner), bal);

    await loadActivityFeed();
  } catch (err) {
    showToast(`Failed to read contract state: ${decodeContractError(err)}`, "error");
  }
}

function renderTransactionsTable(txItems, thresholdNum, isConnectedOwner, walletBalanceWei) {
  const loadingEl = document.getElementById("txLoadingState");
  const tableEl = document.getElementById("txTable");
  const tbody = document.getElementById("txTableBody");

  if (txItems.length === 0) {
    loadingEl.textContent = "No proposals submitted yet. Use the form above to create transaction #0.";
    loadingEl.classList.remove("hidden");
    tableEl.classList.add("hidden");
    return;
  }

  loadingEl.classList.add("hidden");
  tableEl.classList.remove("hidden");
  tbody.innerHTML = "";

  for (const item of txItems) {
    const tr = document.createElement("tr");
    const isExecutableNow =
      item.status === 2 && item.timeLeft === 0 && item.approvals >= thresholdNum;

    const statusInfo = isExecutableNow
      ? { label: "Executable", css: "status-exec" }
      : STATUS_META[item.status] || { label: "Unknown", css: "status-4" };

    const isPendingOrQueued = item.status === 1 || item.status === 2;

    let approveReason = "";
    if (!isConnectedOwner) approveReason = "Connect an active Owner account to approve";
    else if (!isPendingOrQueued) approveReason = `Cannot approve a ${statusInfo.label} transaction`;
    else if (item.myApproved) approveReason = "You have already approved this transaction";

    let revokeReason = "";
    if (!isConnectedOwner) revokeReason = "Connect an active Owner account to revoke";
    else if (!isPendingOrQueued) revokeReason = `Cannot revoke from a ${statusInfo.label} transaction`;
    else if (!item.myApproved) revokeReason = "You have not approved this transaction";

    let executeReason = "";
    if (!isConnectedOwner) executeReason = "Connect an active Owner account to execute";
    else if (item.status === 5) executeReason = "Transaction expired (past 7-day grace window)";
    else if (item.status !== 2) executeReason = "Transaction must be Queued before execution";
    else if (item.approvals < thresholdNum) executeReason = "Active approvals dropped below threshold";
    else if (item.timeLeft > 0) executeReason = `Timelock active (${item.timeLeft}s remaining)`;
    else if (walletBalanceWei < item.value) executeReason = "Insufficient wallet ETH balance";

    let cancelReason = "";
    const isProposer =
      connectedAccount && item.proposer.toLowerCase() === connectedAccount.toLowerCase();
    if (!isConnectedOwner) cancelReason = "Connect an active Owner account to cancel";
    else if (!isPendingOrQueued) cancelReason = `Cannot cancel a ${statusInfo.label} transaction`;
    else if (!isProposer && item.myCancelVoted) cancelReason = "You already voted to cancel";

    const cancelLabel = isProposer
      ? "Cancel"
      : `Vote Cancel (${item.cancelVotes}/${thresholdNum})`;

    const pct = Math.min(100, Math.round((item.approvals / Math.max(1, thresholdNum)) * 100));
    const chipsHtml = item.approverAddresses
      .map((a) => {
        const isMe = connectedAccount && a.toLowerCase() === connectedAccount.toLowerCase();
        return `<span class="signer-tag" title="${a}">${shortAddr(a)}${isMe ? " · You" : ""}</span>`;
      })
      .join("");

    tr.innerHTML = `
      <td class="mono tabular">#${item.id}</td>
      <td>
        <div class="tx-title">${escapeHtml(item.note || "Untitled proposal")}</div>
        <div class="tx-sub mono" title="${item.proposer}">Proposer: ${shortAddr(item.proposer)}</div>
      </td>
      <td class="mono" title="${item.to}">${shortAddr(item.to)}</td>
      <td class="mono num tabular">${ethers.formatEther(item.value)} ETH</td>
      <td>
        <div class="approval-cell">
          <div class="approval-ratio tabular">${item.approvals} / ${thresholdNum}</div>
          <div class="progress-track">
            <div class="progress-fill ${item.approvals >= thresholdNum ? "complete" : ""}" style="width: ${pct}%"></div>
          </div>
          <div class="signer-list">${chipsHtml || '<span class="muted">None</span>'}</div>
        </div>
      </td>
      <td><span class="status-badge ${statusInfo.css}">${statusInfo.label}</span></td>
      <td class="countdown-timer tabular" data-tx-id="${item.id}">
        ${item.status === 2 ? formatDuration(item.timeLeft) : "—"}
      </td>
      <td>
        <div class="action-group">
          <button class="btn btn-primary btn-xs" data-action="approve" data-id="${item.id}"
            ${approveReason ? `disabled title="${approveReason}"` : 'title="Approve this proposal"'}>
            Approve
          </button>
          <button class="btn btn-warning btn-xs" data-action="revoke" data-id="${item.id}"
            ${revokeReason ? `disabled title="${revokeReason}"` : 'title="Withdraw your approval"'}>
            Revoke
          </button>
          <button class="btn btn-success btn-xs" data-action="execute" data-id="${item.id}"
            ${executeReason ? `disabled title="${executeReason}"` : 'title="Execute unlocked transaction"'}>
            Execute
          </button>
          <button class="btn btn-danger btn-xs" data-action="cancel" data-id="${item.id}"
            ${cancelReason ? `disabled title="${cancelReason}"` : 'title="Cancel or vote to cancel"'}>
            ${cancelLabel}
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function startLiveCountdownTicker() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const item of cachedTransactions) {
      if (item.status !== 2) continue;
      const elapsed = nowSec - item.fetchedAtSec;
      const currentLeft = Math.max(0, item.timeLeft - elapsed);
      const cell = document.querySelector(`.countdown-timer[data-tx-id="${item.id}"]`);
      if (cell) {
        cell.textContent = formatDuration(currentLeft);
      }
      if (item.timeLeft > 0 && currentLeft === 0) {
        item.timeLeft = 0;
        refreshDashboard();
      }
    }
  }, 1000);
}

async function loadActivityFeed() {
  if (!contract || !provider) return;

  try {
    const logs = await contract.queryFilter("*", -10000);
    if (!logs || logs.length === 0) {
      cachedFeedItems = [];
      renderActivityFeed();
      return;
    }

    const recentLogs = logs.slice(-40).reverse();
    const parsed = [];

    for (const log of recentLogs) {
      const block = await provider.getBlock(log.blockNumber);
      const timeStr = block
        ? new Date(Number(block.timestamp) * 1000).toLocaleString()
        : `Block #${log.blockNumber}`;

      const name = log.fragment ? log.fragment.name : "Event";
      const args = log.args || [];
      let detail = "";

      if (name === "Deposited") {
        detail = `${ethers.formatEther(args[1])} ETH received from <span class="mono">${shortAddr(args[0])}</span>`;
      } else if (name === "Submitted") {
        detail = `Tx #${args[0]} by <span class="mono">${shortAddr(args[1])}</span> to <span class="mono">${shortAddr(args[2])}</span> (${ethers.formatEther(args[3])} ETH — "${escapeHtml(args[5])}")`;
      } else if (name === "Approved") {
        detail = `Tx #${args[0]} signed by <span class="mono">${shortAddr(args[1])}</span>`;
      } else if (name === "Revoked") {
        detail = `Tx #${args[0]} approval withdrawn by <span class="mono">${shortAddr(args[1])}</span>`;
      } else if (name === "Queued") {
        detail = `Tx #${args[0]} locked until UNIX ${args[1]}`;
      } else if (name === "Executed") {
        detail = `Tx #${args[0]} executed by <span class="mono">${shortAddr(args[1])}</span>`;
      } else if (name === "Cancelled") {
        detail = `Tx #${args[0]} cancelled by <span class="mono">${shortAddr(args[1])}</span>`;
      } else if (name === "OwnerAdded") {
        detail = `Added signatory <span class="mono">${shortAddr(args[0])}</span>`;
      } else if (name === "OwnerRemoved") {
        detail = `Removed signatory <span class="mono">${shortAddr(args[0])}</span>`;
      } else if (name === "ThresholdChanged") {
        detail = `Approval threshold updated to ${args[0]}`;
      } else if (name === "DelayChanged") {
        detail = `Timelock delay updated to ${args[0]}s`;
      }

      parsed.push({
        name,
        detail,
        timeStr,
        txHash: log.transactionHash || "",
      });
    }

    cachedFeedItems = parsed;
    renderActivityFeed();
  } catch (_) {
    // Ignore filter range limitations on public RPCs
  }
}

function renderActivityFeed() {
  const feedEl = document.getElementById("activityFeed");
  const filterVal = document.getElementById("eventFilterSelect").value;

  const filtered = cachedFeedItems.filter((item) => {
    if (filterVal === "ALL") return true;
    if (filterVal === "GOVERNANCE") return GOVERNANCE_EVENTS.has(item.name);
    return item.name === filterVal;
  });

  if (filtered.length === 0) {
    feedEl.innerHTML = `<li class="muted">No matching events recorded yet.</li>`;
    return;
  }

  const baseUrl =
    appConfig && appConfig.etherscanBaseUrl && appConfig.etherscanBaseUrl.startsWith("https://")
      ? appConfig.etherscanBaseUrl
      : null;

  feedEl.innerHTML = "";
  for (const item of filtered) {
    const tagClass = `ev-${item.name.toLowerCase()}`;
    const txLinkHtml =
      item.txHash && baseUrl
        ? `<a class="etherscan-link" href="${baseUrl}/tx/${item.txHash}" target="_blank" rel="noopener noreferrer">${shortAddr(item.txHash)}</a>`
        : item.txHash
        ? `<span class="muted mono">${shortAddr(item.txHash)}</span>`
        : "";

    const li = document.createElement("li");
    li.innerHTML = `
      <div class="activity-main">
        <span class="event-tag ${tagClass}">${escapeHtml(item.name)}</span>
        <span>${item.detail}</span>
      </div>
      <div class="feed-meta">
        ${txLinkHtml}
        <span class="muted mono tabular">${item.timeStr}</span>
      </div>
    `;
    feedEl.appendChild(li);
  }
}

async function sendContractTx(actionLabel, txPromiseFactory) {
  try {
    showToast(`${actionLabel}: Waiting for MetaMask signature...`, "info");
    const tx = await txPromiseFactory();
    showToast(`${actionLabel}: Broadcasted, waiting for confirmation...`, "info", tx.hash);
    await tx.wait();
    showToast(`${actionLabel}: Confirmed on-chain.`, "success", tx.hash);
    await refreshDashboard();
  } catch (err) {
    showToast(decodeContractError(err), "error");
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

window.addEventListener("DOMContentLoaded", async () => {
  await initConfigAndAbi();
  startLiveCountdownTicker();

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-tab");
      document.querySelectorAll(".tab-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      document.getElementById(`tab-${target}`).classList.add("active");
    });
  });

  document.getElementById("connectBtn").addEventListener("click", connectWallet);
  document.getElementById("switchSepoliaBtn").addEventListener("click", switchToSepolia);
  document.getElementById("loadContractBtn").addEventListener("click", bindContractAndRefresh);
  document.getElementById("refreshBtn").addEventListener("click", refreshDashboard);
  document.getElementById("eventFilterSelect").addEventListener("change", renderActivityFeed);

  document.getElementById("depositBtn").addEventListener("click", async () => {
    if (!signer || !contract) {
      showToast("Connect MetaMask first.", "error");
      return;
    }
    const valStr = document.getElementById("depositAmount").value || "0.05";
    await sendContractTx(`Deposit ${valStr} ETH`, async () => {
      return signer.sendTransaction({
        to: await contract.getAddress(),
        value: ethers.parseEther(valStr),
      });
    });
  });

  document.getElementById("proposeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const to = document.getElementById("propRecipient").value.trim();
    const amountStr = document.getElementById("propAmount").value.trim() || "0";
    const dataHex = document.getElementById("propData").value.trim() || "0x";
    const note = document.getElementById("propNote").value.trim();

    if (!ethers.isAddress(to) || to === ethers.ZeroAddress) {
      showToast("Enter a valid non-zero 0x recipient address.", "error");
      return;
    }
    if (!dataHex.startsWith("0x")) {
      showToast("Calldata must start with 0x.", "error");
      return;
    }

    let valueWei = 0n;
    try {
      valueWei = ethers.parseEther(amountStr);
    } catch (_) {
      showToast("Invalid ETH amount.", "error");
      return;
    }

    if (valueWei === 0n && dataHex === "0x") {
      showToast("Enter an ETH amount > 0 or provide hex calldata.", "error");
      return;
    }
    if (valueWei > cachedBalanceWei) {
      showToast(
        `Notice: Proposal value (${amountStr} ETH) exceeds current treasury balance (${ethers.formatEther(cachedBalanceWei)} ETH).`,
        "info"
      );
    }

    await sendContractTx("Submit Proposal", () =>
      contract.submit(to, valueWei, dataHex, note)
    );
    document.getElementById("propNote").value = "";
  });

  const govActionEl = document.getElementById("govAction");
  const govParamLabel = document.getElementById("govParamLabel");
  const govParamInput = document.getElementById("govParam");

  govActionEl.addEventListener("change", () => {
    const act = govActionEl.value;
    if (act === "addOwner") {
      govParamLabel.textContent = "New Owner Address";
      govParamInput.placeholder = "0x...";
    } else if (act === "removeOwner") {
      govParamLabel.textContent = "Owner Address to Remove";
      govParamInput.placeholder = "0x...";
    } else if (act === "changeThreshold") {
      govParamLabel.textContent = "New Approval Threshold (2 to N)";
      govParamInput.placeholder = "e.g., 2";
    } else if (act === "changeDelay") {
      govParamLabel.textContent = "New Timelock Delay in Seconds (10 to 2592000)";
      govParamInput.placeholder = "e.g., 120";
    }
  });

  document.getElementById("govForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const act = govActionEl.value;
    const rawParam = govParamInput.value.trim();
    const note = document.getElementById("govNote").value.trim();

    try {
      const walletAddr = await contract.getAddress();
      const param =
        act === "addOwner" || act === "removeOwner" ? rawParam : BigInt(rawParam);
      const encodedData = contract.interface.encodeFunctionData(act, [param]);

      await sendContractTx(`Governance Proposal (${act})`, () =>
        contract.submit(walletAddr, 0n, encodedData, note)
      );
    } catch (err) {
      showToast(decodeContractError(err), "error");
    }
  });

  document.getElementById("txTableBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || btn.disabled) return;

    const action = btn.getAttribute("data-action");
    const id = Number(btn.getAttribute("data-id"));

    if (action === "approve") {
      await sendContractTx(`Approve Tx #${id}`, () => contract.approve(id));
    } else if (action === "revoke") {
      await sendContractTx(`Revoke Tx #${id}`, () => contract.revoke(id));
    } else if (action === "execute") {
      await sendContractTx(`Execute Tx #${id}`, () => contract.execute(id));
    } else if (action === "cancel") {
      await sendContractTx(`Cancel Tx #${id}`, () => contract.voteCancel(id));
    }
  });

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", async (accounts) => {
      if (accounts.length === 0) {
        connectedAccount = null;
        document.getElementById("accountBadge").textContent = "Disconnected";
      } else {
        await connectWallet();
      }
    });

    window.ethereum.on("chainChanged", () => {
      window.location.reload();
    });
  }
});
