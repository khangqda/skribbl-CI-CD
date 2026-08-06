const { SecretClient } = require("@azure/keyvault-secrets");
const { DefaultAzureCredential } = require("@azure/identity");

// Tên Key Vault của bác trên Azure Portal
const keyVaultName = process.env.KEY_VAULT_NAME || "skribbl-kv";
const KVUri = `https://${keyVaultName}.vault.azure.net`;

// Khởi tạo Credential tự động nhận diện môi trường
const credential = new DefaultAzureCredential();
const client = new SecretClient(KVUri, credential);

// Hàm lấy Secret theo tên
async function getSecret(secretName) {
  try {
    const secret = await client.getSecret(secretName);
    console.log(`🔑 [Key Vault] Đã lấy thành công Secret: ${secretName}`);
    return secret.value;
  } catch (error) {
    console.error(`❌ [Key Vault] Lỗi khi lấy Secret ${secretName}:`, error.message);
    throw error;
  }
}

module.exports = { getSecret };