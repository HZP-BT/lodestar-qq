/*
 * Manual-map payload with no CRT dependency.
 *
 * windows.h is intentionally not included: with -nostdlib the MinGW headers are
 * unavailable, and the payload must import only kernel32 so a manual mapper does
 * not have to satisfy the UCRT or run TLS callbacks.
 */

typedef void* HANDLE;
typedef unsigned long DWORD;
typedef int BOOL;

#define GENERIC_WRITE 0x40000000u
#define OPEN_EXISTING 3u
#define INVALID_HANDLE_VALUE ((HANDLE)(long long)-1)

__declspec(dllimport) HANDLE __stdcall CreateFileA(
    const char* name,
    DWORD desired_access,
    DWORD share_mode,
    void* security_attributes,
    DWORD creation_disposition,
    DWORD flags_and_attributes,
    HANDLE template_file);

__declspec(dllimport) BOOL __stdcall WriteFile(
    HANDLE file,
    const void* buffer,
    DWORD bytes_to_write,
    DWORD* bytes_written,
    void* overlapped);

__declspec(dllimport) BOOL __stdcall CloseHandle(HANDLE object);

__declspec(dllimport) void __stdcall Sleep(DWORD milliseconds);

#define PIPE_NAME "\\\\.\\pipe\\polaris-spike"

static void SendPipeMessage(void) {
    for (int i = 0; i < 100; i++) {
        HANDLE pipe = CreateFileA(
            PIPE_NAME,
            GENERIC_WRITE,
            0,
            (void*)0,
            OPEN_EXISTING,
            0,
            (HANDLE)0);

        if (pipe != INVALID_HANDLE_VALUE) {
            const char message[] = "polaris-spike-payload-attached";
            DWORD written = 0;
            WriteFile(pipe, message, sizeof(message) - 1, &written, (void*)0);
            CloseHandle(pipe);
            return;
        }

        Sleep(50);
    }
}

/*
 * Custom entry point. The manual mapper calls this with the remote image base
 * as the first argument; it must not depend on CRT initialization.
 */
__declspec(dllexport) void payload_main(void* image_base) {
    (void)image_base;
    SendPipeMessage();
}
