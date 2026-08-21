package dev.cursorremote.android.data.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec

interface DeviceCredentialStore {
    fun createDeviceKey(): PublicKey

    fun getDeviceKey(): PublicKey?

    fun deleteDeviceKey()
}

class AndroidKeystoreDeviceCredentialStore : DeviceCredentialStore {
    override fun createDeviceKey(): PublicKey {
        val generator =
            KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC,
                ANDROID_KEYSTORE,
            )
        val spec =
            KeyGenParameterSpec.Builder(DEVICE_KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec(EC_CURVE_P256))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
        generator.initialize(spec)
        return generator.generateKeyPair().public
    }

    override fun getDeviceKey(): PublicKey? {
        val keyStore = loadKeyStore()
        val entry = keyStore.getEntry(DEVICE_KEY_ALIAS, null) as? KeyStore.PrivateKeyEntry
        return entry?.certificate?.publicKey
    }

    override fun deleteDeviceKey() {
        loadKeyStore().deleteEntry(DEVICE_KEY_ALIAS)
    }

    private fun loadKeyStore(): KeyStore {
        return KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val DEVICE_KEY_ALIAS = "cursor_remote_device_ec_p256"
        const val EC_CURVE_P256 = "secp256r1"
    }
}
