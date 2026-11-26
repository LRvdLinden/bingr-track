package nl.lrvdlinden.bingrtrack;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class TraktSessionVault {
    private static final String ALIAS = "BingrTrack.TraktSession";
    private static final int IV_BYTES = 12;

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey cached = (SecretKey) store.getKey(ALIAS,null);
        if (cached != null) return cached;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    static synchronized Object handle(Context context, JSONObject message) throws Exception {
        String scope = message.getString("scope");
        if (!scope.matches("[A-Za-z0-9_-]{1,64}[.][A-Za-z0-9_-]{1,64}")) return JSONObject.NULL;
        SharedPreferences storage = context.getSharedPreferences(ALIAS,Context.MODE_PRIVATE);
        String action = message.getString("action");
        if ("clearTraktSession".equals(action)) return storage.edit().remove(scope).commit();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        if ("readTraktSession".equals(action)) {
            String saved = storage.getString(scope,null);
            if (saved == null) return JSONObject.NULL;
            byte[] bytes = Base64.decode(saved,Base64.NO_WRAP);
            if (bytes.length <= IV_BYTES) return JSONObject.NULL;
            cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,bytes,0,IV_BYTES));
            cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(bytes,IV_BYTES,bytes.length - IV_BYTES),StandardCharsets.UTF_8);
        }
        if ("saveTraktSession".equals(action)) {
            byte[] token = message.getString("data").getBytes(StandardCharsets.UTF_8);
            if (token.length > 8192) return false;
            cipher.init(Cipher.ENCRYPT_MODE,key());
            cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            if (iv.length != IV_BYTES) return false;
            byte[] encrypted = cipher.doFinal(token);
            byte[] packed = Arrays.copyOf(iv,iv.length + encrypted.length);
            System.arraycopy(encrypted,0,packed,iv.length,encrypted.length);
            return storage.edit().putString(scope,Base64.encodeToString(packed,Base64.NO_WRAP)).commit();
        }
        return JSONObject.NULL;
    }
}
