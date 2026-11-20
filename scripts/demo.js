const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const STATUS_NAMES = {
  0: "None",
  1: "Pending",
  2: "Queued",
  3: "Executed",
  4: "Cancelled",
  5: "Expired (Derived)",
};

async function printTxState(wallet, id, stepLabel) {
  const tx = await wallet.getTransaction(id);
  const statusNum = Number(await wallet.getStatus(id));
  const remaining = Number(await wallet.timeLeft(id));
  const thresh = Number(await wallet.threshold());
  console.log(
    `   -> [${stepLabel}] Tx #${id} ("${tx.note}") | Status: ${STATUS_NAMES[statusNum]} (${statusNum}) | Approvals: ${tx.approvals}/${thresh} | CancelVotes: ${tx.cancelVotes}/${thresh} | TimeLeft: ${remaining}s`
  );
}

async function main() {
  const { ethers } = hre;
  const [owner1, owner2, owner3, owner4, recipient] = await ethers.getSigners();

  console.log("======================================================================");
  console.log("   MULTI-SIGNATURE TIME-LOCKED WALLET — END-TO-END LOCAL DEMO");
  console.log("======================================================================\n");

  const initialOwners = [owner1.address, owner2.address, owner3.address];
  const threshold = 2;
  const delay = 60; // 60 seconds

  console.log("STEP 1: Deploy MultiSigTimelockWallet (3 owners, threshold = 2, delay = 60s)");
  const Wallet = await ethers.getContractFactory("MultiSigTimelockWallet");
  const wallet = await Wallet.deploy(initialOwners, threshold, delay);
  await wallet.waitForDeployment();
  const walletAddr = await wallet.getAddress();
  console.log(`   Wallet Address : ${walletAddr}`);
  console.log(`   Owner 1        : ${owner1.address}`);
  console.log(`   Owner 2        : ${owner2.address}`);
  console.log(`   Owner 3        : ${owner3.address}`);
  console.log(`   Recipient      : ${recipient.address}\n`);

  console.log("STEP 2: Deposit 1.0 ETH into the wallet");
  await owner1.sendTransaction({
    to: walletAddr,
    value: ethers.parseEther("1.0"),
  });
  const walletBal = await ethers.provider.getBalance(walletAddr);
  console.log(`   Wallet Balance : ${ethers.formatEther(walletBal)} ETH\n`);

  console.log("STEP 3: Owner 1 submits Tx #0 (Transfer 0.1 ETH to Recipient)");
  await wallet
    .connect(owner1)
    .submit(recipient.address, ethers.parseEther("0.1"), "0x", "Lab equipment reimbursement");
  await printTxState(wallet, 0, "After Owner 1 Submit");
  console.log("");

  console.log("STEP 4: Try to execute Tx #0 immediately with only 1 approval (Expect Failure)");
  try {
    await wallet.connect(owner1).execute(0);
  } catch (err) {
    console.log(`   Expected Revert Caught: ${err.customErrorName || err.message} (Needs 2 approvals to become Queued)\n`);
  }

  console.log("STEP 5: Owner 2 approves Tx #0 (Reaches threshold 2/2 -> Status becomes Queued)");
  await wallet.connect(owner2).approve(0);
  await printTxState(wallet, 0, "After Owner 2 Approve");
  console.log("");

  console.log("STEP 6: Try to execute Tx #0 before the 60s time-lock finishes (Expect TooEarly)");
  try {
    await wallet.connect(owner1).execute(0);
  } catch (err) {
    console.log(`   Expected Revert Caught: ${err.customErrorName || err.message} (Time-lock is still counting down)\n`);
  }

  console.log("STEP 7: Owner 2 revokes approval on Tx #0 (Drops below threshold -> Returns to Pending, timer cleared)");
  await wallet.connect(owner2).revoke(0);
  await printTxState(wallet, 0, "After Owner 2 Revoke");
  console.log("");

  console.log("STEP 8: Owner 2 approves Tx #0 again (Starts a fresh 60s timer)");
  await wallet.connect(owner2).approve(0);
  await printTxState(wallet, 0, "After Owner 2 Re-Approve");
  console.log("");

  console.log("STEP 9: Advance blockchain time by 61 seconds and execute Tx #0");
  const recBalBefore = await ethers.provider.getBalance(recipient.address);
  await time.increase(61);
  await printTxState(wallet, 0, "After 61s Time Travel (Unlocked)");
  await wallet.connect(owner1).execute(0);
  const recBalAfter = await ethers.provider.getBalance(recipient.address);
  await printTxState(wallet, 0, "After Execution");
  console.log(`   Recipient Balance Before : ${ethers.formatEther(recBalBefore)} ETH`);
  console.log(`   Recipient Balance After  : ${ethers.formatEther(recBalAfter)} ETH`);
  console.log(`   Net Received             : +${ethers.formatEther(recBalAfter - recBalBefore)} ETH\n`);

  console.log("STEP 10: Owner 1 submits Tx #1 and cancels it immediately as Proposer");
  await wallet
    .connect(owner1)
    .submit(recipient.address, ethers.parseEther("0.05"), "0x", "Accidental duplicate payment");
  await printTxState(wallet, 1, "After Tx #1 Submit");
  await wallet.connect(owner1).voteCancel(1);
  await printTxState(wallet, 1, "After Proposer Cancel");
  console.log("");

  console.log("STEP 11: Governance Proposal (Tx #2) — Add Owner 4 via onlySelf execution");
  const addOwnerData = wallet.interface.encodeFunctionData("addOwner", [owner4.address]);
  await wallet
    .connect(owner1)
    .submit(walletAddr, 0, addOwnerData, "Governance: Add Owner 4");
  await printTxState(wallet, 2, "After Governance Submit");
  await wallet.connect(owner2).approve(2);
  await printTxState(wallet, 2, "After Owner 2 Approves Governance Tx");
  await time.increase(61);
  await wallet.connect(owner1).execute(2);
  await printTxState(wallet, 2, "After Governance Execution");

  const updatedOwners = await wallet.getOwners();
  console.log(`   Updated Owners (${updatedOwners.length}):`, updatedOwners);
  console.log("\n======================================================================");
  console.log("   DEMO COMPLETED SUCCESSFULLY");
  console.log("======================================================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
