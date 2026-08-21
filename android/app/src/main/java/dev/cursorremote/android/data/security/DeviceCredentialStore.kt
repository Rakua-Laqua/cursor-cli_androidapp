package dev.cursorremote.android.data.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

interface DeviceCredentialStore {
    fun createDeviceKey(): PublicKey

    fun getDeviceKey(): PublicKey?

    fun deleteDeviceKey()

    fun signSha256Ecdsa(payload: ByteArray): ByteArray
}

class AndroidKeystoreDeviceCredentialStore : DeviceCredentialStore {
    override fun createDeviceKey(): PublicKey {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(DEVICE_KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec(EC_CURVE_P256))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        return generator.generateKeyPair().public
    }

    override fun getDeviceKey(): PublicKey? {
        val entry = loadKeyStore().getEntry(DEVICE_KEY_ALIAS, null) as? KeyStore.PrivateKeyEntry
        return entry?.certificate?.publicKey
    }

    override fun deleteDeviceKey() {
        loadKeyStore().deleteEntry(DEVICE_KEY_ALIAS)
    }

    override fun signSha256Ecdsa(payload: ByteArray): ByteArray {
        val entry =
            loadKeyStore().getEntry(DEVICE_KEY_ALIAS, null) as? KeyStore.PrivateKeyEntry
                ?: throw IllegalStateException("Device key is not available")
        val signature = Signature.getInstance(SIGNATURE_ALGORITHM)
        signature.initSign(entry.privateKey)
        signature.update(payload)
        return signature.sign()
    }

    private fun loadKeyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val DEVICE_KEY_ALIAS = "cursor_remote_device_ec_p256"
        const val EC_CURVE_P256 = "secp256r1"
        const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
    }
}
