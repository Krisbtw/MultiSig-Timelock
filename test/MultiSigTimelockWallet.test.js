const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("MultiSigTimelockWallet", function () {
  const DELAY = 60; // 60 seconds
  const THRESHOLD = 2;
  const GRACE_PERIOD = 7 * 24 * 60 * 60; // 7 days in seconds

  async function deployWalletFixture() {
    const [owner1, owner2, owner3, nonOwner, recipient, extraOwner] = await ethers.getSigners();
    const owners = [owner1.address, owner2.address, owner3.address];

    const Wallet = await ethers.getContractFactory("MultiSigTimelockWallet");
    const wallet = await Wallet.deploy(owners, THRESHOLD, DELAY);
    await wallet.waitForDeployment();

    // Fund wallet with 10 ETH for transaction tests
    await owner1.sendTransaction({
      to: await wallet.getAddress(),
      value: ethers.parseEther("10.0"),
    });

    return { wallet, Wallet, owners, owner1, owner2, owner3, nonOwner, recipient, extraOwner };
  }

  describe("Deployment & Constructor Validation", function () {
    it("T1: constructor stores owners, threshold, and delay correctly", async function () {
      const { wallet, owners } = await loadFixture(deployWalletFixture);

      expect(await wallet.getOwners()).to.deep.equal(owners);
      expect(await wallet.threshold()).to.equal(THRESHOLD);
      expect(await wallet.delay()).to.equal(DELAY);
      expect(await wallet.txCount()).to.equal(0);

      for (const addr of owners) {
        expect(await wallet.isOwner(addr)).to.equal(true);
      }
    });

    it("T2: invalid threshold (1, or above owner count) reverts InvalidThreshold", async function () {
      const { Wallet, owners } = await loadFixture(deployWalletFixture);

      await expect(Wallet.deploy(owners, 1, DELAY)).to.be.revertedWithCustomError(
        Wallet,
        "InvalidThreshold"
      );
      await expect(Wallet.deploy(owners, 4, DELAY)).to.be.revertedWithCustomError(
        Wallet,
        "InvalidThreshold"
      );
    });

    it("T3: duplicate or zero-address owner reverts InvalidOwner", async function () {
      const { Wallet, owner1, owner2 } = await loadFixture(deployWalletFixture);

      await expect(
        Wallet.deploy([owner1.address, owner2.address, ethers.ZeroAddress], THRESHOLD, DELAY)
      ).to.be.revertedWithCustomError(Wallet, "InvalidOwner");

      await expect(
        Wallet.deploy([owner1.address, owner2.address, owner1.address], THRESHOLD, DELAY)
      ).to.be.revertedWithCustomError(Wallet, "InvalidOwner");
    });

    it("T3b: fewer than 3 owners or more than 10 owners reverts InvalidOwner", async function () {
      const { Wallet, owner1, owner2 } = await loadFixture(deployWalletFixture);

      await expect(
        Wallet.deploy([owner1.address, owner2.address], THRESHOLD, DELAY)
      ).to.be.revertedWithCustomError(Wallet, "InvalidOwner");

      const elevenOwners = Array.from({ length: 11 }, (_, i) =>
        ethers.Wallet.createRandom().address
      );
      await expect(Wallet.deploy(elevenOwners, THRESHOLD, DELAY)).to.be.revertedWithCustomError(
        Wallet,
        "InvalidOwner"
      );
    });

    it("T3c: delay out of bounds (< 10s or > 30d) reverts InvalidDelay", async function () {
      const { Wallet, owners } = await loadFixture(deployWalletFixture);

      await expect(Wallet.deploy(owners, THRESHOLD, 9)).to.be.revertedWithCustomError(
        Wallet,
        "InvalidDelay"
      );
      await expect(
        Wallet.deploy(owners, THRESHOLD, 30 * 24 * 60 * 60 + 1)
      ).to.be.revertedWithCustomError(Wallet, "InvalidDelay");
    });
  });

  describe("Deposits, Submissions & Approvals", function () {
    it("T4: sending ETH emits Deposited and raises wallet balance", async function () {
      const { wallet, nonOwner } = await loadFixture(deployWalletFixture);
      const walletAddr = await wallet.getAddress();
      const beforeBal = await ethers.provider.getBalance(walletAddr);
      const depositAmount = ethers.parseEther("1.5");

      await expect(
        nonOwner.sendTransaction({ to: walletAddr, value: depositAmount })
      )
        .to.emit(wallet, "Deposited")
        .withArgs(nonOwner.address, depositAmount, beforeBal + depositAmount);

      expect(await ethers.provider.getBalance(walletAddr)).to.equal(beforeBal + depositAmount);
    });

    it("T5: non-owner submit reverts NotOwner", async function () {
      const { wallet, nonOwner, recipient } = await loadFixture(deployWalletFixture);

      await expect(
        wallet.connect(nonOwner).submit(recipient.address, ethers.parseEther("1.0"), "0x", "test")
      ).to.be.revertedWithCustomError(wallet, "NotOwner");
    });

    it("T6: submit creates Pending transaction with proposer auto-approved (approvalCount 1) and emits Submitted", async function () {
      const { wallet, owner1, recipient } = await loadFixture(deployWalletFixture);
      const value = ethers.parseEther("1.0");

      await expect(wallet.connect(owner1).submit(recipient.address, value, "0x", "Lab payout"))
        .to.emit(wallet, "Submitted")
        .withArgs(0, owner1.address, recipient.address, value, "0x", "Lab payout")
        .and.to.emit(wallet, "Approved")
        .withArgs(0, owner1.address);

      const txData = await wallet.getTransaction(0);
      expect(txData.to).to.equal(recipient.address);
      expect(txData.value).to.equal(value);
      expect(txData.proposer).to.equal(owner1.address);
      expect(txData.status).to.equal(1); // Status.Pending
      expect(txData.approvals).to.equal(1);
      expect(await wallet.approvalCount(0)).to.equal(1);
      expect(await wallet.getStatus(0)).to.equal(1);
    });

    it("T7: second approval makes transaction Queued with unlockTime equal to approval time plus delay", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployWalletFixture);
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("1.0"), "0x", "tx0");

      const tx = await wallet.connect(owner2).approve(0);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const expectedUnlock = BigInt(block.timestamp) + BigInt(DELAY);

      await expect(tx)
        .to.emit(wallet, "Approved")
        .withArgs(0, owner2.address)
        .and.to.emit(wallet, "Queued")
        .withArgs(0, expectedUnlock);

      const txData = await wallet.getTransaction(0);
      expect(txData.status).to.equal(2); // Status.Queued
      expect(txData.unlockTime).to.equal(expectedUnlock);
      expect(txData.approvals).to.equal(2);
      expect(await wallet.timeLeft(0)).to.equal(DELAY);
    });

    it("T8: same owner approving twice reverts AlreadyApproved", async function () {
      const { wallet, owner1, recipient } = await loadFixture(deployWalletFixture);
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("1.0"), "0x", "tx0");

      await expect(wallet.connect(owner1).approve(0)).to.be.revertedWithCustomError(
        wallet,
        "AlreadyApproved"
      );
    });
  });

  describe("Time-Locked Execution & Expiry", function () {
    it("T9: execute before delay finishes reverts TooEarly", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployWalletFixture);
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("1.0"), "0x", "tx0");
      await wallet.connect(owner2).approve(0);

      await time.increase(DELAY - 5);
      await expect(wallet.connect(owner1).execute(0)).to.be.revertedWithCustomError(
        wallet,
        "TooEarly"
      );
    });

    it("T10: execute after delay sends exact ETH to recipient and sets status to Executed", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployWalletFixture);
      const amount = ethers.parseEther("1.25");
      await wallet.connect(owner1).submit(recipient.address, amount, "0x", "payout");
      await wallet.connect(owner2).approve(0);

      await time.increase(DELAY + 1);
      expect(await wallet.timeLeft(0)).to.equal(0);

      const beforeRecipientBal = await ethers.provider.getBalance(recipient.address);
      await expect(wallet.connect(owner1).execute(0))
        .to.emit(wallet, "Executed")
        .withArgs(0, owner1.address, recipient.address, amount, "0x");

      const afterRecipientBal = await ethers.provider.getBalance(recipient.address);
      expect(afterRecipientBal - beforeRecipientBal).to.equal(amount);

      const txData = await wallet.getTransaction(0);
      expect(txData.status).to.equal(3); // Status.Executed
      expect(await wallet.getStatus(0)).to.equal(3);
    });

    it("T11: second execute on an already executed transaction reverts NotQueued", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployWalletFixture);
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("0.5"), "0x", "tx0");
      await wallet.connect(owner2).approve(0);
      await time.increase(DELAY + 1);
      await wallet.connect(owner1).execute(0);

      await expect(wallet.connect(owner2).execute(0)).to.be.revertedWithCustomError(
        wallet,
        "NotQueued"
      );
    });

    it("T12: execute after unlockTime + 7 days reverts Expired and getStatus returns 5", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployWalletFixture);
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("0.5"), "0x", "tx0");
      await wallet.connect(owner2).approve(0);

      await time.increase(DELAY + GRACE_PERIOD + 2);

      expect(await wallet.isExpired(0)).to.equal(true);
      expect(await wallet.getStatus(0)).to.equal(5); // 5 = Derived Expired

      await expect(wallet.connect(owner1).execute(0)).to.be.revertedWithCustomError(
        wallet,
        "Expired"
      );
    });
  });

  describe("Revocation & Cancellation", function () {
    it("T13: revoke while Queued, dropping below threshold, returns to Pending and clears unlockTime", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployWalletFixture);
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("0.5"), "0x", "tx0");
      await wallet.connect(owner2).approve(0);

      await expect(wallet.connect(owner2).revoke(0))
        .to.emit(wallet, "Revoked")
        .withArgs(0, owner2.address);

      const txData = await wallet.getTransaction(0);
      expect(txData.status).to.equal(1); // Status.Pending
      expect(txData.unlockTime).to.equal(0);
      expect(txData.approvals).to.equal(1);
    });

    it("T14: re-approve after revoke starts a NEW timer from the new approval time", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployWalletFixture);
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("0.5"), "0x", "tx0");
      await wallet.connect(owner2).approve(0);

      const firstUnlock = (await wallet.getTransaction(0)).unlockTime;

      await time.increase(30);
      await wallet.connect(owner2).revoke(0);
      await time.increase(20);

      await wallet.connect(owner2).approve(0);
      const secondUnlock = (await wallet.getTransaction(0)).unlockTime;

      expect(secondUnlock).to.be.gt(firstUnlock);
    });

    it("T15: proposer cancels immediately, status becomes Cancelled, execute then fails", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployWalletFixture);
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("0.5"), "0x", "tx0");
      await wallet.connect(owner2).approve(0);

      await expect(wallet.connect(owner1).voteCancel(0))
        .to.emit(wallet, "Cancelled")
        .withArgs(0, owner1.address);

      expect(await wallet.getStatus(0)).to.equal(4); // Status.Cancelled

      await time.increase(DELAY + 1);
      await expect(wallet.connect(owner2).execute(0)).to.be.revertedWithCustomError(
        wallet,
        "NotQueued"
      );
    });

    it("T16: two non-proposer owners voting cancel reaches threshold and cancels; a single vote does not", async function () {
      const { wallet, owner1, owner2, owner3, recipient } = await loadFixture(deployWalletFixture);
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("0.5"), "0x", "tx0");

      // Single non-proposer cancel vote does not cancel yet (threshold = 2)
      await wallet.connect(owner2).voteCancel(0);
      expect(await wallet.cancelCount(0)).to.equal(1);
      expect(await wallet.getStatus(0)).to.equal(1); // Still Pending

      // Second non-proposer cancel vote reaches threshold and cancels
      await expect(wallet.connect(owner3).voteCancel(0))
        .to.emit(wallet, "Cancelled")
        .withArgs(0, owner3.address);

      expect(await wallet.getStatus(0)).to.equal(4); // Cancelled
    });

    it("T16b: a non-proposer owner cannot cancel-vote twice", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployWalletFixture);
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("0.5"), "0x", "tx0");

      await wallet.connect(owner2).voteCancel(0);
      await expect(wallet.connect(owner2).voteCancel(0)).to.be.revertedWithCustomError(
        wallet,
        "AlreadyApproved"
      );
    });
  });

  describe("Self-Governance (onlySelf Proposals)", function () {
    it("T17: calling governance functions directly from an owner reverts NotSelf", async function () {
      const { wallet, owner1, extraOwner } = await loadFixture(deployWalletFixture);

      await expect(wallet.connect(owner1).addOwner(extraOwner.address)).to.be.revertedWithCustomError(
        wallet,
        "NotSelf"
      );
      await expect(wallet.connect(owner1).removeOwner(owner1.address)).to.be.revertedWithCustomError(
        wallet,
        "NotSelf"
      );
      await expect(wallet.connect(owner1).changeThreshold(3)).to.be.revertedWithCustomError(
        wallet,
        "NotSelf"
      );
      await expect(wallet.connect(owner1).changeDelay(120)).to.be.revertedWithCustomError(
        wallet,
        "NotSelf"
      );
    });

    it("T18: full governance flow for addOwner updates owners array, isOwner, and emits OwnerAdded", async function () {
      const { wallet, owner1, owner2, extraOwner } = await loadFixture(deployWalletFixture);
      const walletAddr = await wallet.getAddress();
      const data = wallet.interface.encodeFunctionData("addOwner", [extraOwner.address]);

      await wallet.connect(owner1).submit(walletAddr, 0, data, "Add 4th owner");
      await wallet.connect(owner2).approve(0);
      await time.increase(DELAY + 1);

      await expect(wallet.connect(owner1).execute(0))
        .to.emit(wallet, "OwnerAdded")
        .withArgs(extraOwner.address);

      expect(await wallet.isOwner(extraOwner.address)).to.equal(true);
      const updatedOwners = await wallet.getOwners();
      expect(updatedOwners.length).to.equal(4);
      expect(updatedOwners).to.include(extraOwner.address);
    });

    it("T18b: full governance flow for changeDelay and changeThreshold updates settings and emits events", async function () {
      const { wallet, owner1, owner2 } = await loadFixture(deployWalletFixture);
      const walletAddr = await wallet.getAddress();

      // 1. Change delay to 120s
      const delayData = wallet.interface.encodeFunctionData("changeDelay", [120]);
      await wallet.connect(owner1).submit(walletAddr, 0, delayData, "Change delay to 120s");
      await wallet.connect(owner2).approve(0);
      await time.increase(DELAY + 1);

      await expect(wallet.connect(owner1).execute(0))
        .to.emit(wallet, "DelayChanged")
        .withArgs(120);
      expect(await wallet.delay()).to.equal(120);

      // 2. Change threshold to 3
      const threshData = wallet.interface.encodeFunctionData("changeThreshold", [3]);
      await wallet.connect(owner1).submit(walletAddr, 0, threshData, "Raise threshold to 3");
      await wallet.connect(owner2).approve(1);
      await time.increase(120 + 1);

      await expect(wallet.connect(owner1).execute(1))
        .to.emit(wallet, "ThresholdChanged")
        .withArgs(3);
      expect(await wallet.threshold()).to.equal(3);
    });

    it("T18c: removeOwner works when >3 owners exist and removed owner can no longer call submit", async function () {
      const { wallet, owner1, owner2, owner3, extraOwner, recipient } =
        await loadFixture(deployWalletFixture);
      const walletAddr = await wallet.getAddress();

      // First add extraOwner so there are 4 owners
      const addData = wallet.interface.encodeFunctionData("addOwner", [extraOwner.address]);
      await wallet.connect(owner1).submit(walletAddr, 0, addData, "Add extraOwner");
      await wallet.connect(owner2).approve(0);
      await time.increase(DELAY + 1);
      await wallet.connect(owner1).execute(0);

      // Now remove owner3 so 3 owners remain
      const removeData = wallet.interface.encodeFunctionData("removeOwner", [owner3.address]);
      await wallet.connect(owner1).submit(walletAddr, 0, removeData, "Remove owner3");
      await wallet.connect(owner2).approve(1);
      await time.increase(DELAY + 1);

      await expect(wallet.connect(owner1).execute(1))
        .to.emit(wallet, "OwnerRemoved")
        .withArgs(owner3.address);

      expect(await wallet.isOwner(owner3.address)).to.equal(false);
      await expect(
        wallet.connect(owner3).submit(recipient.address, 100, "0x", "should fail")
      ).to.be.revertedWithCustomError(wallet, "NotOwner");
    });

    it("T19: proposal to change threshold above owner count reverts at execute and tx stays Queued", async function () {
      const { wallet, owner1, owner2 } = await loadFixture(deployWalletFixture);
      const walletAddr = await wallet.getAddress();

      const badData = wallet.interface.encodeFunctionData("changeThreshold", [5]);
      await wallet.connect(owner1).submit(walletAddr, 0, badData, "Invalid threshold 5");
      await wallet.connect(owner2).approve(0);
      await time.increase(DELAY + 1);

      await expect(wallet.connect(owner1).execute(0)).to.be.revertedWithCustomError(
        wallet,
        "ExecutionFailed"
      );

      // Status remains Queued because revert rolled back the Executed status assignment
      const txData = await wallet.getTransaction(0);
      expect(txData.status).to.equal(2); // Status.Queued
    });
  });

  describe("Security Edge Cases & Invariants", function () {
    it("T20: reentrancy attack during execute fails on inner call and wallet loses only intended amount", async function () {
      const { wallet, owner1, owner2 } = await loadFixture(deployWalletFixture);
      const walletAddr = await wallet.getAddress();

      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await Attacker.deploy(walletAddr);
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      const amount = ethers.parseEther("1.0");
      await wallet.connect(owner1).submit(attackerAddr, amount, "0x", "Attack test");
      await attacker.setTargetTxId(0);
      await wallet.connect(owner2).approve(0);
      await time.increase(DELAY + 1);

      const walletBalBefore = await ethers.provider.getBalance(walletAddr);
      await wallet.connect(owner1).execute(0);
      const walletBalAfter = await ethers.provider.getBalance(walletAddr);

      // Attacker received ETH once, attempted reentrancy once, and the inner call failed
      expect(await attacker.attackCount()).to.equal(1);
      expect(await attacker.reentrantCallSucceeded()).to.equal(false);
      expect(walletBalBefore - walletBalAfter).to.equal(amount);
    });

    it("T21: execute with insufficient wallet ETH balance reverts InsufficientBalance", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployWalletFixture);
      const excessiveAmount = ethers.parseEther("500.0");

      await wallet.connect(owner1).submit(recipient.address, excessiveAmount, "0x", "Too large");
      await wallet.connect(owner2).approve(0);
      await time.increase(DELAY + 1);

      await expect(wallet.connect(owner1).execute(0)).to.be.revertedWithCustomError(
        wallet,
        "InsufficientBalance"
      );
    });

    it("T22: after removeOwner, a Queued tx whose valid approvals fall below threshold cannot execute (NotApproved) and sync() demotes it to Pending", async function () {
      const { wallet, owner1, owner2, owner3, extraOwner, recipient } =
        await loadFixture(deployWalletFixture);
      const walletAddr = await wallet.getAddress();

      // Add extraOwner first so we have 4 owners
      const addData = wallet.interface.encodeFunctionData("addOwner", [extraOwner.address]);
      await wallet.connect(owner1).submit(walletAddr, 0, addData, "Add extraOwner");
      await wallet.connect(owner2).approve(0);
      await time.increase(DELAY + 1);
      await wallet.connect(owner1).execute(0);

      // Create tx 1 approved by owner1 and owner3 -> Queued (2 approvals)
      await wallet.connect(owner1).submit(recipient.address, ethers.parseEther("1.0"), "0x", "tx1");
      await wallet.connect(owner3).approve(1);
      expect((await wallet.getTransaction(1)).status).to.equal(2); // Queued

      // Create & execute tx 2 to remove owner3 (approved by owner1 and owner2)
      const removeData = wallet.interface.encodeFunctionData("removeOwner", [owner3.address]);
      await wallet.connect(owner1).submit(walletAddr, 0, removeData, "Remove owner3");
      await wallet.connect(owner2).approve(2);
      await time.increase(DELAY + 1);
      await wallet.connect(owner1).execute(2);

      // Now tx 1 only has 1 active owner approval (owner1), below threshold (2)
      expect(await wallet.approvalCount(1)).to.equal(1);
      await expect(wallet.connect(owner1).execute(1)).to.be.revertedWithCustomError(
        wallet,
        "NotApproved"
      );

      // Calling sync(1) demotes it back to Pending and clears unlockTime
      await wallet.sync(1);
      const syncedTx = await wallet.getTransaction(1);
      expect(syncedTx.status).to.equal(1); // Status.Pending
      expect(syncedTx.unlockTime).to.equal(0);
    });

    it("T23: additional edge checks (submit to zero address, third approval on Queued keeps unlockTime, invalid tx IDs)", async function () {
      const { wallet, owner1, owner2, owner3, recipient } = await loadFixture(deployWalletFixture);

      // Submit to zero address reverts InvalidOwner
      await expect(
        wallet.connect(owner1).submit(ethers.ZeroAddress, 0, "0x", "zero target")
      ).to.be.revertedWithCustomError(wallet, "InvalidOwner");

      // Non-existent tx ID reverts TxNotFound across views and actions
      await expect(wallet.getTransaction(99)).to.be.revertedWithCustomError(wallet, "TxNotFound");
      await expect(wallet.getStatus(99)).to.be.revertedWithCustomError(wallet, "TxNotFound");
      await expect(wallet.timeLeft(99)).to.be.revertedWithCustomError(wallet, "TxNotFound");
      await expect(wallet.connect(owner1).approve(99)).to.be.revertedWithCustomError(
        wallet,
        "TxNotFound"
      );

      // Third approval on already Queued tx records approval without altering unlockTime
      await wallet.connect(owner1).submit(recipient.address, 100, "0x", "tx0");
      await wallet.connect(owner2).approve(0);
      const queuedUnlock = (await wallet.getTransaction(0)).unlockTime;

      await time.increase(15);
      await wallet.connect(owner3).approve(0);
      const afterThirdApprove = await wallet.getTransaction(0);
      expect(afterThirdApprove.approvals).to.equal(3);
      expect(afterThirdApprove.unlockTime).to.equal(queuedUnlock);

      // Revoking when 3 owners approved (leaving 2 >= threshold) keeps it Queued
      await wallet.connect(owner3).revoke(0);
      expect((await wallet.getTransaction(0)).status).to.equal(2);
    });
  });
});
