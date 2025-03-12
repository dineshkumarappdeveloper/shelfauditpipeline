const { BlobServiceClient } = require("@azure/storage-blob");
const fs = require("fs-extra");
const path = require("path");
const { spawn, execSync } = require("child_process");

// ✅ Azure Storage Configuration
const AZURE_CONNECTION_STRING = "SharedAccessSignature=sv=2023-01-03&ss=btqf&srt=sco&st=2025-03-04T14%3A39%3A40Z&se=2025-04-30T14%3A39%3A00Z&sp=rwlacp&sig=k8LKGisFP2mXvIBGkdDaoRrsV6zeTvX9xi0sa2ogddg%3D;BlobEndpoint=https://blkshelfauditeus2sad01.blob.core.windows.net/;";
const CONTAINER_NAME = "data-upload";
const FOLDER_NAME = "upc_data/18/";
const TEMP_DIR = "/tmp/adb_transfer/"; // Temporary local storage
//const DEVICE_DESTINATION = "/data/data/ai.blackstraw.shelfauditlib.test/files/"; // ✅ Always use /sdcard/
const DEVICE_DESTINATION = "/storage/emulated/0/Android/media/com.iri.blackstrawtest/"; // ✅ Always use /sdcard/
//const DEVICE_DESTINATION = "/sdcard/upc_data/"; // ✅ Always use /sdcard/

// 🔹 Get list of connected ADB devices
function getADBDevices() {
    try {
        const devicesOutput = execSync("adb devices").toString().trim();
        const devices = devicesOutput.split("\n").slice(1) // Remove header line
            .map(line => line.split("\t")[0]) // Extract device ID
            .filter(id => id !== ""); // Remove empty lines

        if (devices.length === 0) {
            throw new Error("No ADB devices found!");
        }
        console.log(`📱 Connected devices: ${devices.join(", ")}`);

        return devices[0]; // Pick the first device (modify if needed)
    } catch (error) {
        console.error("❌ Error getting ADB devices:", error.message);
        return null;
    }
}

// 🔹 Ensure /sdcard/upc_data/ exists on the Android device
function ensureADBDirectory(deviceId, directoryPath) {
    try {
        execSync(`adb -s ${deviceId} shell mkdir -p ${directoryPath}`);
        console.log(`✅ Ensured writable ADB directory: ${directoryPath}`);
    } catch (error) {
        console.error(`❌ Failed to create ADB directory: ${directoryPath}`, error.message);
    }
}

// 🔹 Download each file and move it immediately to the ADB device
async function downloadAndMoveFile(blobClient, localFilePath, deviceFilePath, deviceId) {
    try {
        console.log(`⬇️ Downloading: ${blobClient.name} -> ${localFilePath}`);
        await blobClient.downloadToFile(localFilePath);
        console.log(`✅ Downloaded: ${localFilePath}`);

        // Ensure the subfolder exists on the ADB device
        const adbFolderPath = path.dirname(deviceFilePath);
        ensureADBDirectory(deviceId, adbFolderPath);

        console.log(`📲 Transferring to ADB device: ${deviceFilePath}`);

        // Transfer the file via ADB push
        const adbPush = spawn("adb", ["-s", deviceId, "push", localFilePath, deviceFilePath], { stdio: "inherit" });

        adbPush.on("close", (code) => {
            if (code === 0) {
                console.log(`✅ Successfully moved to device: ${deviceFilePath}`);
                fs.remove(localFilePath) // Delete local temp file after successful transfer
                    .then(() => console.log(`🗑️ Deleted temp file: ${localFilePath}`))
                    .catch(err => console.error(`❌ Failed to delete temp file: ${localFilePath}`, err.message));
            } else {
                console.error(`❌ Failed to move: ${deviceFilePath}`);
            }
        });

    } catch (error) {
        console.error(`❌ Error downloading/moving file ${blobClient.name}:`, error.message);
    }
}

// 🔹 Download all files and move them one by one
async function downloadFilesAndMoveToADB() {
    try {
        const deviceId = getADBDevices();
        if (!deviceId) {
            console.error("❌ No valid ADB device found. Exiting.");
            return;
        }

        // ✅ Ensure the ADB destination folder exists
        ensureADBDirectory(deviceId, DEVICE_DESTINATION);

        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONNECTION_STRING);
        const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

        console.log(`📥 Downloading files from folder: ${FOLDER_NAME}...`);

        // Ensure the temp local directory exists
        await fs.ensureDir(TEMP_DIR);

        for await (const blob of containerClient.listBlobsFlat({ prefix: FOLDER_NAME })) {
            const blobClient = containerClient.getBlobClient(blob.name);
            const upcNumber = blobClient.name.split("/").slice(-2, -1)[0];

            // ✅ Ensure the subfolder exists on the local temp directory
            const localFolder = path.join(TEMP_DIR, upcNumber);
            await fs.ensureDir(localFolder);

            const localFilePath = path.join(localFolder, path.basename(blob.name));
            const deviceFilePath = `${DEVICE_DESTINATION}${upcNumber}/${path.basename(blob.name)}`;

            // ✅ Ensure the file is writable before moving
            await fs.chmod(localFilePath, 0o777).catch(err => console.error(`❌ Failed to set permissions: ${localFilePath}`, err.message));

            if (blobClient.name.endsWith(".png") || blobClient.name.endsWith(".jpg")) {
                await downloadAndMoveFile(blobClient, localFilePath, deviceFilePath, deviceId);
            }
        }

        console.log("✅ All files downloaded and moved successfully!");
        runGradleCommand();
    } catch (error) {
        console.error("❌ Error processing files from Azure Blob:", error.message);
    }
}

// 🔹 Run the Gradle test command
function runGradleCommand() {
    console.log("🚀 Running Gradle test...");

    const gradleProcess = spawn("source ~/.bash_profile && ./gradlew", [
        "connectedAndroidTest",
        "-Pandroid.testInstrumentationRunnerArguments.class=com.bs.shelfaudithelper.PermissionTest#testGrantPermissionsAtLaunch"
    ], {
        cwd: "/Users/dinesh/AndroidStudioProjects/ShelfAuditHelper",
        shell: true
    });

    gradleProcess.stdout.on("data", (data) => console.log(`Gradle Output: ${data}`));
    gradleProcess.stderr.on("data", (data) => console.error(`Gradle Error: ${data}`));
    gradleProcess.on("close", (code) => console.log(`Gradle process exited with code ${code}`));
}

// 🔹 Start Process: Download Each File → Move to ADB → Run Gradle Test
downloadFilesAndMoveToADB();