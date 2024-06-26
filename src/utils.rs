use alloc::{format, rc::Rc, string::String, vec, vec::Vec};
use core::ffi::CStr;

#[derive(PartialEq)]
pub struct LoError {
    pub message: String,
    pub loc: LoLocation,
}

impl LoError {
    pub fn unreachable(file: &str, line: u32) -> LoError {
        LoError {
            message: format!("Unreachable in {}:{}", file, line),
            loc: LoLocation::internal(),
        }
    }
}

impl core::fmt::Display for LoError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{loc} - {msg}", loc = self.loc, msg = self.message)
    }
}

impl From<LoError> for String {
    fn from(err: LoError) -> Self {
        format!("{err}")
    }
}

#[derive(Debug, PartialEq, Clone)]
pub struct LoPosition {
    pub offset: usize,
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, PartialEq, Clone)]
pub struct LoLocation {
    pub file_name: Rc<str>,

    pub pos: LoPosition,
    pub end_pos: LoPosition,
}

impl LoLocation {
    pub fn internal() -> Self {
        LoLocation {
            file_name: "<internal>".into(),
            pos: LoPosition {
                offset: 0,
                line: 1,
                col: 1,
            },
            end_pos: LoPosition {
                offset: 0,
                line: 1,
                col: 1,
            },
        }
    }
}

impl core::fmt::Display for LoLocation {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}:{}:{}", self.file_name, self.pos.line, self.pos.col)
    }
}

const CWD_PREOPEN_FD: u32 = 3;

pub struct WasiArgs {
    size: usize,
    argv: Vec<*mut u8>,
    _argv_buf: Vec<u8>,
}

impl WasiArgs {
    pub fn load() -> Result<Self, wasi::Errno> {
        let (argv_size, argv_buf_size) = unsafe { wasi::args_sizes_get() }?;

        let mut argv = vec![core::ptr::null::<u8>() as *mut u8; argv_size];
        let mut _argv_buf = vec![0u8; argv_buf_size];
        if argv_size != 0 {
            unsafe { wasi::args_get(argv.as_mut_ptr() as *mut *mut u8, _argv_buf.as_mut_ptr()) }?;
        }

        Ok(Self {
            size: argv_size,
            argv,
            _argv_buf,
        })
    }

    pub fn len(&self) -> usize {
        return self.size;
    }

    pub fn get(&self, index: usize) -> Option<&str> {
        if index >= self.len() {
            return None;
        }

        unsafe { CStr::from_ptr(self.argv[index] as *const i8).to_str().ok() }
    }
}

pub fn proc_exit(exit_code: u32) -> ! {
    unsafe { wasi::proc_exit(exit_code) };
    unreachable!(); // needed for typesystem
}

/// Hack for https://github.com/microsoft/vscode-wasm/issues/161
pub fn unlock_fs() -> Result<(), wasi::Errno> {
    use alloc::alloc::*;

    let prestat = unsafe { wasi::fd_prestat_get(CWD_PREOPEN_FD) }?;
    let path_len = unsafe { prestat.u.dir.pr_name_len };
    let path_buf = unsafe { alloc_zeroed(Layout::from_size_align(path_len, 8).unwrap()) };
    let _ = unsafe { wasi::fd_prestat_dir_name(CWD_PREOPEN_FD, path_buf, path_len) }?;
    let _ = unsafe { wasi::fd_prestat_get(CWD_PREOPEN_FD + 1) };
    let _ = unsafe { wasi::fd_fdstat_get(CWD_PREOPEN_FD) };
    Ok(())
}

pub fn fd_open(file_path: &str) -> Result<u32, wasi::Errno> {
    unsafe { wasi::path_open(CWD_PREOPEN_FD, 1, &file_path, 0, 264240830, 268435455, 0) }
}

pub fn stdin_read() -> Vec<u8> {
    fd_read_all_and_close(wasi::FD_STDIN)
}

pub fn fd_read_all_and_close(fd: u32) -> Vec<u8> {
    let mut output = Vec::<u8>::new();
    let mut chunk = [0; 256];

    let in_vec = [wasi::Iovec {
        buf: chunk.as_mut_ptr(),
        buf_len: chunk.len(),
    }];

    loop {
        let nread = match unsafe { wasi::fd_read(fd, &in_vec) } {
            Ok(nread) => nread,
            Err(err) => {
                // stdin is empty
                if fd == 0 && err == wasi::ERRNO_AGAIN {
                    break;
                }

                stderr_write(alloc::format!("Error reading file: fd={fd}, err={err}\n").as_bytes());
                unreachable!()
            }
        };

        if nread == 0 {
            break;
        }

        output.extend(&chunk[0..nread]);
    }

    if fd != 0 {
        let _ = unsafe { wasi::fd_close(fd) };
    }

    output
}

pub fn stdout_write(message: &[u8]) {
    fputs(wasi::FD_STDOUT, message);
}

pub fn stdout_writeln(message: impl AsRef<str>) {
    stdout_write(message.as_ref().as_bytes());
    stdout_write("\n".as_bytes());
}

pub fn stderr_write(message: &[u8]) {
    fputs(wasi::FD_STDERR, message);
}

pub fn fputs(fd: u32, message: &[u8]) {
    let out_vec = [wasi::Ciovec {
        buf: message.as_ptr(),
        buf_len: message.len(),
    }];

    unsafe { wasi::fd_write(fd, &out_vec) }.unwrap();
}

#[allow(dead_code)]
pub fn debug(msg: String) {
    unsafe {
        wasi::fd_write(
            wasi::FD_STDERR,
            &[
                wasi::Ciovec {
                    buf: msg.as_ptr(),
                    buf_len: msg.as_bytes().len(),
                },
                wasi::Ciovec {
                    buf: "\n".as_ptr(),
                    buf_len: 1,
                },
            ],
        )
        .unwrap();
    }
}

pub fn resolve_path(file_path: &str, relative_to: &str) -> String {
    if !file_path.starts_with('.') {
        return file_path.into();
    }

    let mut path_items = relative_to.split('/').collect::<Vec<_>>();
    path_items.pop(); // remove `relative_to`'s file name

    path_items.extend(file_path.split('/'));

    let mut i = 0;
    loop {
        if i >= path_items.len() {
            break;
        }

        if path_items[i] == "." {
            path_items.remove(i);
            continue;
        }

        if path_items[i] == ".." && i > 0 {
            i -= 1;
            path_items.remove(i);
            path_items.remove(i);
            continue;
        }

        i += 1;
    }

    path_items.join("/")
}

pub struct ListDisplay<'a, T: core::fmt::Display>(pub &'a Vec<T>);

impl<'a, T: core::fmt::Display> core::fmt::Display for ListDisplay<'a, T> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let mut iter = self.0.iter();
        if let Some(item) = iter.next() {
            write!(f, "{item}")?;
        }
        for item in iter {
            write!(f, ", {item}")?;
        }
        Ok(())
    }
}

pub struct RangeDisplay<'a>(pub &'a LoLocation);

impl<'a> core::fmt::Display for RangeDisplay<'a> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let sl = self.0.pos.line;
        let sc = self.0.pos.col;
        let el = self.0.end_pos.line;
        let ec = self.0.end_pos.col;

        write!(f, "{sl}:{sc}-{el}:{ec}")?;
        Ok(())
    }
}
