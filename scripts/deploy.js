const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const { ethers, network } = hre;

  // Read configuration from .env or fall back to local Hardhat defaults
  let owners = [];
  if (process.env.OWNERS && process.env.OWNERS.trim() !== "") {
    owners = process.env.OWNERS.split(",")
      .map((addr) => addr.trim())
      .filter(Boolean);
  } else {
    const signers = await ethers.getSigners();
    owners = [signers[0].address, signers[1].address, signers[2].address];
    console.log("No OWNERS in .env; using first 3 Hardhat signers:", owners);
  }

  const threshold = Number(process.env.THRESHOLD || 2);
  const delay = Number(process.env.DELAY || 60);

  console.log("------------------------------------------------------------");
  console.log(`Deploying MultiSigTimelockWallet to network: ${network.name}`);
  console.log(`Owners (${owners.length}):`, owners);
  console.log(`Threshold : ${threshold} of ${owners.length}`);
  console.log(`Delay     : ${delay} seconds`);
  console.log("------------------------------------------------------------");

  const Wallet = await ethers.getContractFactory("MultiSigTimelockWallet");
  const wallet = await Wallet.deploy(owners, threshold, delay);
  await wallet.waitForDeployment();

  const contractAddress = await wallet.getAddress();
  console.log(`MultiSigTimelockWallet deployed to: ${contractAddress}`);

  // Write ABI and config to frontend/
  const artifact = hre.artifacts.readArtifactSync("MultiSigTimelockWallet");
  const frontendDir = path.join(__dirname, "..", "frontend");
  fs.mkdirSync(frontendDir, { recursive: true });

  const abiPath = path.join(frontendDir, "abi.json");
  const configPath = path.join(frontendDir, "config.json");

  fs.writeFileSync(abiPath, JSON.stringify(artifact.abi, null, 2));

  const chainId = network.name === "sepolia" ? 11155111 : 31337;
  const configData = {
    contractAddress,
    networkName: network.name,
    chainId,
    etherscanBaseUrl:
      chainId === 11155111 ? "https://sepolia.etherscan.io" : "http://localhost:8545",
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));

  console.log("Saved ABI to     : frontend/abi.json");
  console.log("Saved Config to  : frontend/config.json");

  // Optional Etherscan verification on Sepolia
  if (network.name === "sepolia" && process.env.ETHERSCAN_API_KEY) {
    console.log("Attempting contract verification on Sepolia Etherscan...");
    try {
      await hre.run("verify:verify", {
        address: contractAddress,
        constructorArguments: [owners, threshold, delay],
      });
      console.log("Contract verified on Etherscan!");
    } catch (err) {
      console.log("Etherscan verification note:", err.message);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
