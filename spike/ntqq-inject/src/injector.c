#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PIPE_NAME "\\\\.\\pipe\\polaris-spike"

typedef struct {
    HANDLE process;
    HANDLE thread;
    LPVOID remote_base;
} Injection;

static BOOL ReadFileBytes(const char* path, PBYTE* data, DWORD* size) {
    FILE* file = fopen(path, "rb");
    if (!file) {
        return FALSE;
    }
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return FALSE;
    }
    long length = ftell(file);
    if (length <= 0) {
        fclose(file);
        return FALSE;
    }
    rewind(file);
    PBYTE buffer = (PBYTE)malloc((size_t)length);
    if (!buffer) {
        fclose(file);
        return FALSE;
    }
    if (fread(buffer, 1, (size_t)length, file) != (size_t)length) {
        free(buffer);
        fclose(file);
        return FALSE;
    }
    fclose(file);
    *data = buffer;
    *size = (DWORD)length;
    return TRUE;
}

static BOOL RelocateImage(PBYTE image, ULONGLONG remote_base) {
    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)image;
    IMAGE_NT_HEADERS64* nt = (IMAGE_NT_HEADERS64*)(image + dos->e_lfanew);
    IMAGE_DATA_DIRECTORY directory =
        nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_BASERELOC];

    if (directory.VirtualAddress == 0 || directory.Size == 0) {
        return TRUE;
    }

    ULONGLONG delta = remote_base - nt->OptionalHeader.ImageBase;
    if (delta == 0) {
        return TRUE;
    }

    IMAGE_BASE_RELOCATION* reloc =
        (IMAGE_BASE_RELOCATION*)(image + directory.VirtualAddress);
    PBYTE end = image + directory.VirtualAddress + directory.Size;

    while ((PBYTE)reloc < end && reloc->SizeOfBlock >= sizeof(IMAGE_BASE_RELOCATION)) {
        DWORD count = (reloc->SizeOfBlock - sizeof(IMAGE_BASE_RELOCATION)) / sizeof(WORD);
        WORD* entries = (WORD*)(reloc + 1);

        for (DWORD i = 0; i < count; i++) {
            WORD entry = entries[i];
            WORD type = (WORD)(entry >> 12);
            WORD offset = (WORD)(entry & 0x0FFF);
            PBYTE target = image + reloc->VirtualAddress + offset;

            if (type == IMAGE_REL_BASED_DIR64) {
                *(ULONGLONG*)target += delta;
            } else if (type == IMAGE_REL_BASED_HIGHLOW) {
                *(DWORD*)target += (DWORD)delta;
            }
        }

        reloc = (IMAGE_BASE_RELOCATION*)((PBYTE)reloc + reloc->SizeOfBlock);
    }

    return TRUE;
}

static BOOL ResolveImports(PBYTE image) {
    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)image;
    IMAGE_NT_HEADERS64* nt = (IMAGE_NT_HEADERS64*)(image + dos->e_lfanew);
    IMAGE_DATA_DIRECTORY directory =
        nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];

    if (directory.VirtualAddress == 0 || directory.Size == 0) {
        return TRUE;
    }

    IMAGE_IMPORT_DESCRIPTOR* import =
        (IMAGE_IMPORT_DESCRIPTOR*)(image + directory.VirtualAddress);

    for (; import->Name != 0; import++) {
        const char* module_name = (const char*)(image + import->Name);
        HMODULE module = GetModuleHandleA(module_name);
        if (!module) {
            module = LoadLibraryA(module_name);
        }
        if (!module) {
            fprintf(stderr, "LoadLibrary failed: %s\n", module_name);
            return FALSE;
        }

        DWORD thunk_rva = import->OriginalFirstThunk ? import->OriginalFirstThunk
                                                     : import->FirstThunk;
        IMAGE_THUNK_DATA64* thunk = (IMAGE_THUNK_DATA64*)(image + thunk_rva);
        IMAGE_THUNK_DATA64* iat = (IMAGE_THUNK_DATA64*)(image + import->FirstThunk);

        for (; thunk->u1.AddressOfData != 0; thunk++, iat++) {
            FARPROC function = NULL;

            if (IMAGE_SNAP_BY_ORDINAL64(thunk->u1.Ordinal)) {
                function = GetProcAddress(
                    module,
                    (LPCSTR)(ULONG_PTR)IMAGE_ORDINAL64(thunk->u1.Ordinal));
            } else {
                IMAGE_IMPORT_BY_NAME* name =
                    (IMAGE_IMPORT_BY_NAME*)(image + thunk->u1.AddressOfData);
                function = GetProcAddress(module, (LPCSTR)name->Name);
            }

            if (!function) {
                fprintf(stderr, "GetProcAddress failed in %s\n", module_name);
                return FALSE;
            }

            iat->u1.Function = (ULONGLONG)function;
        }
    }

    return TRUE;
}

static BOOL InjectDll(DWORD pid, const char* dll_path, Injection* result) {
    PBYTE file_data = NULL;
    DWORD file_size = 0;
    PBYTE image = NULL;
    HANDLE process = NULL;
    LPVOID remote_base = NULL;
    HANDLE thread = NULL;

    memset(result, 0, sizeof(*result));

    if (!ReadFileBytes(dll_path, &file_data, &file_size)) {
        fprintf(stderr, "cannot read DLL: %s\n", dll_path);
        return FALSE;
    }

    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)file_data;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) {
        fprintf(stderr, "not a PE file\n");
        goto cleanup;
    }

    IMAGE_NT_HEADERS64* nt = (IMAGE_NT_HEADERS64*)(file_data + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE ||
        nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) {
        fprintf(stderr, "not an x64 PE\n");
        goto cleanup;
    }

    DWORD image_size = nt->OptionalHeader.SizeOfImage;
    image = (PBYTE)calloc(1, image_size);
    if (!image) {
        fprintf(stderr, "calloc failed\n");
        goto cleanup;
    }

    memcpy(image, file_data, nt->OptionalHeader.SizeOfHeaders);

    IMAGE_SECTION_HEADER* section = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; i++, section++) {
        if (section->SizeOfRawData == 0) {
            continue;
        }
        if (section->PointerToRawData + section->SizeOfRawData > file_size) {
            fprintf(stderr, "section out of file bounds\n");
            goto cleanup;
        }
        memcpy(
            image + section->VirtualAddress,
            file_data + section->PointerToRawData,
            section->SizeOfRawData);
    }

    process = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION |
            PROCESS_VM_READ | PROCESS_VM_WRITE,
        FALSE,
        pid);
    if (!process) {
        fprintf(stderr, "OpenProcess failed: %lu\n", GetLastError());
        goto cleanup;
    }

    remote_base = VirtualAllocEx(
        process,
        NULL,
        image_size,
        MEM_COMMIT | MEM_RESERVE,
        PAGE_EXECUTE_READWRITE);
    if (!remote_base) {
        fprintf(stderr, "VirtualAllocEx failed: %lu\n", GetLastError());
        goto cleanup;
    }

    if (!RelocateImage(image, (ULONGLONG)remote_base)) {
        goto cleanup;
    }
    if (!ResolveImports(image)) {
        goto cleanup;
    }

    if (!WriteProcessMemory(process, remote_base, image, image_size, NULL)) {
        fprintf(stderr, "WriteProcessMemory failed: %lu\n", GetLastError());
        goto cleanup;
    }

    FlushInstructionCache(process, remote_base, image_size);

    LPTHREAD_START_ROUTINE entry = (LPTHREAD_START_ROUTINE)(
        (PBYTE)remote_base + nt->OptionalHeader.AddressOfEntryPoint);

    thread = CreateRemoteThread(process, NULL, 0, entry, remote_base, 0, NULL);
    if (!thread) {
        fprintf(stderr, "CreateRemoteThread failed: %lu\n", GetLastError());
        goto cleanup;
    }

    result->process = process;
    result->thread = thread;
    result->remote_base = remote_base;
    free(image);
    free(file_data);
    return TRUE;

cleanup:
    if (thread) CloseHandle(thread);
    if (remote_base && process) VirtualFreeEx(process, remote_base, 0, MEM_RELEASE);
    if (process) CloseHandle(process);
    free(image);
    free(file_data);
    return FALSE;
}

int main(int argc, char** argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: injector.exe <pid> <payload.dll>\n");
        return 2;
    }

    DWORD pid = (DWORD)strtoul(argv[1], NULL, 10);
    if (pid == 0) {
        fprintf(stderr, "invalid pid\n");
        return 2;
    }

    HANDLE pipe = CreateNamedPipeA(
        PIPE_NAME,
        PIPE_ACCESS_INBOUND,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1,
        0,
        4096,
        0,
        NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "CreateNamedPipe failed: %lu\n", GetLastError());
        return 3;
    }

    Injection injection;
    if (!InjectDll(pid, argv[2], &injection)) {
        CloseHandle(pipe);
        return 4;
    }

    printf("injected at %p, waiting for pipe...\n", injection.remote_base);

    BOOL connected = ConnectNamedPipe(pipe, NULL);
    if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) {
        fprintf(stderr, "ConnectNamedPipe failed: %lu\n", GetLastError());
    }

    char buffer[256] = {0};
    DWORD read = 0;
    if (ReadFile(pipe, buffer, sizeof(buffer) - 1, &read, NULL)) {
        buffer[read] = '\0';
        printf("pipe message: %s\n", buffer);
    } else {
        fprintf(stderr, "ReadFile failed: %lu\n", GetLastError());
    }

    WaitForSingleObject(injection.thread, 5000);
    CloseHandle(injection.thread);
    VirtualFreeEx(injection.process, injection.remote_base, 0, MEM_RELEASE);
    CloseHandle(injection.process);
    CloseHandle(pipe);
    return 0;
}
