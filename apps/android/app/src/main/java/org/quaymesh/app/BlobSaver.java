package org.quaymesh.app;

import android.content.ContentResolver;
import android.net.Uri;
import java.io.InputStream;
import java.io.OutputStream;

public final class BlobSaver {
    public static final int CHUNK_SIZE = 64 * 1024;
    private BlobSaver() {}

    public static long copy(ContentResolver resolver, InputStream source, Uri destination) throws Exception {
        if (source == null || destination == null) throw new IllegalArgumentException("保存需要有效的来源和用户选择的目标。");
        try (InputStream input = source; OutputStream output = resolver.openOutputStream(destination, "w")) {
            if (output == null) throw new IllegalStateException("系统无法打开用户选择的保存位置。");
            byte[] buffer = new byte[CHUNK_SIZE]; long total = 0; int count;
            while ((count = input.read(buffer)) >= 0) { if (count == 0) continue; output.write(buffer, 0, count); total += count; }
            output.flush(); return total;
        }
    }
}
