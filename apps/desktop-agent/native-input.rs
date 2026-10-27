// Windows-only input broker. No network, passwords, screen capture or shell in
// this process. Physical input fences injection before reporting local takeover.
#![cfg_attr(target_os = "windows", windows_subsystem = "console")]
#[cfg(not(target_os = "windows"))]
fn main() { panic!("Windows required"); }
#[cfg(target_os = "windows")]
#[cfg_attr(test, allow(dead_code))]
mod windows {
    use std::{collections::HashSet, ffi::c_void, io::{self, BufRead, Write}, mem::{size_of, zeroed}, ptr::{null_mut, null}, sync::{Mutex, OnceLock, atomic::{AtomicBool, AtomicU8, Ordering}}};
    type Handle = *mut c_void;
    #[repr(C)] #[derive(Copy, Clone)] struct Mouse { dx:i32, dy:i32, data:u32, flags:u32, time:u32, extra:usize }
    #[repr(C)] #[derive(Copy, Clone)] struct Key { vk:u16, scan:u16, flags:u32, time:u32, extra:usize }
    #[repr(C)] union Data { mouse:Mouse, key:Key }
    #[repr(C)] struct Input { kind:u32, data:Data }
    #[repr(C)] struct Point { x:i32, y:i32 }
    #[repr(C)] #[derive(Default)] struct Rect { left:i32, top:i32, right:i32, bottom:i32 }
    #[repr(C)] struct MouseHook { point:Point, data:u32, flags:u32, time:u32, extra:usize }
    #[repr(C)] struct KeyHook { vk:u32, scan:u32, flags:u32, time:u32, extra:usize }
    #[repr(C)] struct Message { hwnd:Handle, message:u32, wparam:usize, lparam:isize, time:u32, point:Point, private:u32 }
    #[repr(C)] struct Security { length:u32, descriptor:Handle, inherit:i32 }
    #[repr(C)] struct Startup { cb:u32, reserved:*mut u16, desktop:*mut u16, title:*mut u16, x:u32, y:u32, width:u32, height:u32, x_chars:u32, y_chars:u32, fill:u32, flags:u32, show:u16, reserved_size:u16, reserved_bytes:*mut u8, stdin:Handle, stdout:Handle, stderr:Handle }
    #[repr(C)] struct ProcessInfo { process:Handle, thread:Handle, pid:u32, tid:u32 }
    #[repr(C)] struct BasicLimit { process_time:i64, job_time:i64, flags:u32, min_working:usize, max_working:usize, process_limit:u32, affinity:usize, priority:u32, scheduling:u32 }
    #[repr(C)] struct JobLimit { basic:BasicLimit, io:[u64;6], process_memory:usize, job_memory:usize, peak_process:usize, peak_job:usize }
    #[link(name="user32")] extern "system" {
        fn SendInput(n:u32, input:*const Input, size:i32)->u32;
        fn SetWindowsHookExW(id:i32, callback:Option<unsafe extern "system" fn(i32,usize,isize)->isize>, module:Handle, thread:u32)->Handle;
        fn CallNextHookEx(hook:Handle, code:i32, wparam:usize, lparam:isize)->isize;
        fn GetMessageW(message:*mut Message, hwnd:Handle, min:u32, max:u32)->i32;
        fn UnhookWindowsHookEx(hook:Handle)->i32;
        fn GetSystemMetrics(index:i32)->i32;
        fn SetProcessDPIAware()->i32;
        fn SetProcessDpiAwarenessContext(context:isize)->i32;
        fn MapVirtualKeyW(code:u32, kind:u32)->u32;
        fn EnumWindows(callback:Option<unsafe extern "system" fn(Handle,isize)->i32>, value:isize)->i32;
        fn IsWindowVisible(hwnd:Handle)->i32; fn IsIconic(hwnd:Handle)->i32;
        fn GetWindowThreadProcessId(hwnd:Handle,pid:*mut u32)->u32;
        fn GetWindowRect(hwnd:Handle,rect:*mut Rect)->i32;
        fn GetForegroundWindow()->Handle; fn SetForegroundWindow(hwnd:Handle)->i32;
        fn WindowFromPoint(point:Point)->Handle; fn GetAncestor(hwnd:Handle,flags:u32)->Handle;
    }
    #[link(name="dwmapi")] extern "system" { fn DwmGetWindowAttribute(hwnd:Handle,attribute:u32,value:*mut c_void,size:u32)->i32; }
    #[link(name="kernel32")] extern "system" {
        fn GetModuleHandleW(name:*const u16)->Handle; fn GetCurrentProcess()->Handle; fn CloseHandle(handle:Handle)->i32;
        fn CreateJobObjectW(attributes:*const Security,name:*const u16)->Handle;
        fn SetInformationJobObject(job:Handle,class:u32,info:*const c_void,length:u32)->i32;
        fn AssignProcessToJobObject(job:Handle,process:Handle)->i32;
        fn TerminateJobObject(job:Handle,code:u32)->i32;
        fn CreateProcessW(name:*const u16,command:*mut u16,process_attributes:*const Security,thread_attributes:*const Security,inherit:i32,flags:u32,environment:*const c_void,directory:*const u16,startup:*const Startup,info:*mut ProcessInfo)->i32;
        fn GetStdHandle(which:u32)->Handle; fn SetHandleInformation(handle:Handle,mask:u32,flags:u32)->i32;
        fn CreateFileW(name:*const u16,access:u32,sharing:u32,security:*const Security,creation:u32,flags:u32,template:Handle)->Handle;
        fn ResumeThread(thread:Handle)->u32; fn WaitForSingleObject(handle:Handle,milliseconds:u32)->u32;
        fn GetExitCodeProcess(handle:Handle,code:*mut u32)->i32; fn TerminateProcess(handle:Handle,code:u32)->i32;
    }
    #[link(name="advapi32")] extern "system" { fn OpenProcessToken(process:Handle,access:u32,token:*mut Handle)->i32; fn GetTokenInformation(token:Handle,class:u32,value:*mut c_void,length:u32,returned:*mut u32)->i32; }
    static ACTIVE:AtomicBool=AtomicBool::new(false);
    static STATE:OnceLock<Mutex<State>>=OnceLock::new();
    static OUTPUT:Mutex<()>=Mutex::new(());
    static TAKEOVER_CONTEXT:AtomicU8=AtomicU8::new(0);
    static CLEANUP_THREAD:OnceLock<std::thread::Thread>=OnceLock::new();
    struct State { token:String, sequence:u64, heartbeat:std::time::Instant, held_keys:HashSet<u16>, held_buttons:HashSet<u32> }
    const MARK:usize=0x57545a59;
    fn emit(text:&str) { let _guard=OUTPUT.lock().unwrap(); println!("{}",text); let _=io::stdout().flush(); }
    fn mouse(flags:u32, data:u32, x:i32, y:i32)->Input { Input {kind:0, data:Data{mouse:Mouse{dx:x,dy:y,data,flags,time:0,extra:MARK}}} }
    fn key(vk:u16, up:bool)->Input {
        let extended=matches!(vk,0x21..=0x28|0x2d|0x2e|0x5b|0x5c|0xa3|0xa5);
        Input{kind:1,data:Data{key:Key{vk,scan:unsafe{MapVirtualKeyW(vk as u32,0)} as u16,flags:if up{2}else{0}|if extended{1}else{0},time:0,extra:MARK}}}
    }
    fn dispatch(input:Input)->bool { unsafe { SendInput(1,&input,size_of::<Input>() as i32)==1 } }
    fn release(state:&mut State) { for vk in state.held_keys.drain() { dispatch(key(vk,true)); } for button in state.held_buttons.drain() { dispatch(mouse([4,0x40,0x10][button as usize],0,0,0)); } }
    fn paste(state:&mut State)->bool {
        release(state);
        let inputs=[key(0xa2,false),key(86,false),key(86,true),key(0xa2,true)];
        let sent=unsafe{SendInput(4,inputs.as_ptr(),size_of::<Input>() as i32)};
        dispatch(key(86,true));dispatch(key(0xa2,true));sent==4
    }
    fn window_rect(hwnd:Handle)->Option<Rect> { unsafe {
        if IsWindowVisible(hwnd)==0 || IsIconic(hwnd)!=0 {return None;}
        let mut cloaked:u32=0;
        if DwmGetWindowAttribute(hwnd,14,&mut cloaked as *mut _ as *mut c_void,4)==0 && cloaked!=0 {return None;}
        let mut rect=Rect::default();
        if DwmGetWindowAttribute(hwnd,9,&mut rect as *mut _ as *mut c_void,size_of::<Rect>() as u32)!=0 && GetWindowRect(hwnd,&mut rect)==0 {return None;}
        if rect.right<=rect.left || rect.bottom<=rect.top {None}else{Some(rect)}
    }}
    unsafe extern "system" fn enumerate_window(hwnd:Handle,value:isize)->i32 {
        let rows=&mut *(value as *mut Vec<String>);
        if rows.len()>=256 {return 0;}
        if let Some(rect)=window_rect(hwnd) {
            let mut pid=0;GetWindowThreadProcessId(hwnd,&mut pid);
            if pid!=0 {rows.push(format!("{{\"handle\":\"{}\",\"pid\":{},\"width\":{},\"height\":{}}}",hwnd as usize,pid,rect.right-rect.left,rect.bottom-rect.top));}
        }
        1
    }
    fn window_catalog(request:&str) {
        let mut rows:Vec<String>=Vec::new();
        unsafe{EnumWindows(Some(enumerate_window),&mut rows as *mut _ as isize);}
        emit(&format!("{{\"type\":\"windows\",\"requestId\":\"{}\",\"items\":[{}]}}",request,rows.join(",")));
    }
    fn move_pointer(x:i32,y:i32)->bool {
        let (left,top,width,height)=unsafe{(GetSystemMetrics(76),GetSystemMetrics(77),GetSystemMetrics(78),GetSystemMetrics(79))};
        if width<2 || height<2 || x<left || y<top || x>=left+width || y>=top+height {return false;}
        dispatch(mouse(0x8000|0x4000|1,0,((x-left) as i64*65535/(width-1) as i64) as i32,((y-top) as i64*65535/(height-1) as i64) as i32))
    }
    fn window_input(parts:&[&str],state:&mut State)->bool { unsafe {
        if parts.len()<6 {return false;}
        let hwnd=match parts[3].parse::<usize>() {Ok(n) if n>0=>n as Handle,_=>return false};
        let expected=match parts[4].parse::<u32>() {Ok(n) if n>0=>n,_=>return false};
        let mut pid=0;GetWindowThreadProcessId(hwnd,&mut pid);
        if pid!=expected {return false;}
        let kind=parts[5];
        if kind=="release" {release(state);return true;}
        let rect=match window_rect(hwnd) {Some(rect)=>rect,None=>return false};
        // Occluded capture remains viewable. Clicking explicitly brings this
        // window forward; never inject through it into an unrelated window.
        if kind=="down" || kind=="paste" {SetForegroundWindow(hwnd);}
        if GetAncestor(GetForegroundWindow(),2)!=hwnd {return kind=="move";}
        match kind {
            "move"|"down"|"up" if parts.len()>=8=>{
                let x=parts[6].parse::<f64>().unwrap_or(f64::NAN);let y=parts[7].parse::<f64>().unwrap_or(f64::NAN);
                if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {return false;}
                let x=rect.left+(x*(rect.right-rect.left-1) as f64).round() as i32;
                let y=rect.top+(y*(rect.bottom-rect.top-1) as f64).round() as i32;
                if GetAncestor(WindowFromPoint(Point{x,y}),2)!=hwnd {return false;}
                if !move_pointer(x,y) {return false;}
                if kind=="move" {return true;}
                let button=match parts.get(8).and_then(|n|n.parse::<u32>().ok()) {Some(n) if n<3=>n,_=>return false};
                let up=kind=="up";
                if up {state.held_buttons.remove(&button);}else{state.held_buttons.insert(button);}
                dispatch(mouse(if up{[4,0x40,0x10][button as usize]}else{[2,0x20,8][button as usize]},0,0,0))
            },
            "paste"=>paste(state),
            "keydown"|"keyup" if parts.len()==7=>{
                let code=match vk(parts[6]){Some(code)=>code,None=>return false};let up=kind=="keyup";
                if up{state.held_keys.remove(&code);}else{state.held_keys.insert(code);}dispatch(key(code,up))
            },
            "wheel" if parts.len()==8=>{
                let dx=parts[6].parse::<i32>().unwrap_or(0).clamp(-1200,1200);let dy=parts[7].parse::<i32>().unwrap_or(0).clamp(-1200,1200);
                (dy==0||dispatch(mouse(0x0800,(-dy) as u32,0,0)))&&(dx==0||dispatch(mouse(0x1000,dx as u32,0,0)))
            },
            _=>false
        }
    }}
    unsafe extern "system" fn mouse_hook(code:i32,wparam:usize,lparam:isize)->isize {
        if code>=0 {
            let event=&*(lparam as *const MouseHook);
            if event.extra!=MARK { takeover("mouse", event.flags & 1 != 0); }
            else if !ACTIVE.load(Ordering::SeqCst) && !matches!(wparam,0x202|0x205|0x208) { return 1; }
        }
        CallNextHookEx(null_mut(),code,wparam,lparam)
    }
    unsafe extern "system" fn key_hook(code:i32,wparam:usize,lparam:isize)->isize {
        if code>=0 {
            let event=&*(lparam as *const KeyHook);
            if event.extra!=MARK { takeover("keyboard", event.flags & 0x10 != 0); }
            else if !ACTIVE.load(Ordering::SeqCst) && !matches!(wparam,0x101|0x105) { return 1; }
        }
        CallNextHookEx(null_mut(),code,wparam,lparam)
    }
    fn takeover(source:&str,injected:bool) {
        // Never wait on the dispatcher or stdout from a low-level hook. SendInput
        // can be waiting for this same hook thread. Fence now; wake cleanup.
        if ACTIVE.swap(false,Ordering::SeqCst) {
            TAKEOVER_CONTEXT.store(if source=="mouse"{1}else{2}|if injected{4}else{0},Ordering::SeqCst);
            if let Some(thread)=CLEANUP_THREAD.get() { thread.unpark(); }
        }
    }
    fn vk(code:&str)->Option<u16> {
        if code.len()==4 && code.starts_with("Key") { return code.as_bytes().last().filter(|n| n.is_ascii_uppercase()).map(|n| *n as u16); }
        if code.len()==6 && code.starts_with("Digit") { return code.as_bytes().last().filter(|n| n.is_ascii_digit()).map(|n| *n as u16); }
        if let Some(number)=code.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()) { if (1..=12).contains(&number) { return Some(0x6f+number); } }
        Some(match code { "Enter"=>13,"Escape"=>27,"Tab"=>9,"Space"=>32,"Backspace"=>8,"Delete"=>46,"Insert"=>45,"Home"=>36,"End"=>35,"PageUp"=>33,"PageDown"=>34,"ArrowUp"=>38,"ArrowDown"=>40,"ArrowLeft"=>37,"ArrowRight"=>39,"ShiftLeft"=>0xa0,"ShiftRight"=>0xa1,"ControlLeft"=>0xa2,"ControlRight"=>0xa3,"AltLeft"=>0xa4,"AltRight"=>0xa5,"MetaLeft"=>0x5b,"MetaRight"=>0x5c,"CapsLock"=>20,"Minus"=>0xbd,"Equal"=>0xbb,"BracketLeft"=>0xdb,"BracketRight"=>0xdd,"Backslash"=>0xdc,"Semicolon"=>0xba,"Quote"=>0xde,"Backquote"=>0xc0,"Comma"=>0xbc,"Period"=>0xbe,"Slash"=>0xbf,_=>return None })
    }
    fn wide(value:&str)->Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
    fn quote(value:&str)->String {
        if !value.is_empty() && !value.chars().any(|ch|ch.is_whitespace()||ch=='"'){return value.to_owned();}
        let mut out=String::from("\"");let mut slashes=0;
        for ch in value.chars(){if ch=='\\'{slashes+=1;continue;}if ch=='\"'{out.push_str(&"\\".repeat(slashes*2+1));out.push(ch);}else{out.push_str(&"\\".repeat(slashes));out.push(ch);}slashes=0;}
        out.push_str(&"\\".repeat(slashes*2));out.push('"');out
    }
    // The child starts suspended, enters a kill-on-close Job, and only then runs.
    // Descendants cannot request breakaway. Closing/crashing this broker kills
    // the complete Job, including children detached from the original shell.
    fn job_run(args:&[String])->i32 { unsafe {
        if args.len()<2 { return 125; }
        let job=CreateJobObjectW(null(),null());if job.is_null(){return 125;}
        let mut limit:JobLimit=zeroed();limit.basic.flags=0x2000;
        if SetInformationJobObject(job,9,&limit as *const _ as *const c_void,size_of::<JobLimit>() as u32)==0 {CloseHandle(job);return 125;}
        let security=Security{length:size_of::<Security>() as u32,descriptor:null_mut(),inherit:1};
        let input=CreateFileW(wide("NUL").as_ptr(),0x80000000,3,&security,3,0,null_mut());
        let output=GetStdHandle((-11i32) as u32);let error=GetStdHandle((-12i32) as u32);
        if input as isize == -1 || SetHandleInformation(output,1,1)==0 || SetHandleInformation(error,1,1)==0 {CloseHandle(job);return 125;}
        let mut startup:Startup=zeroed();startup.cb=size_of::<Startup>() as u32;startup.flags=0x100;startup.stdin=input;startup.stdout=output;startup.stderr=error;
        let mut info:ProcessInfo=zeroed();let name=wide(&args[0]);
        let command_text=if args.len()==5 && args[0].to_lowercase().ends_with("\\cmd.exe") && args[1..4]==["/d","/s","/c"] {format!("{} /d /s /c \"{}\"",quote(&args[0]),args[4])} else {args.iter().map(|s|quote(s)).collect::<Vec<_>>().join(" ")};
        let mut command=wide(&command_text);
        if CreateProcessW(name.as_ptr(),command.as_mut_ptr(),null(),null(),1,0x08000000|4,null(),null(),&startup,&mut info)==0 {CloseHandle(input);CloseHandle(job);return 125;}
        CloseHandle(input);
        if AssignProcessToJobObject(job,info.process)==0 {TerminateProcess(info.process,125);CloseHandle(info.thread);CloseHandle(info.process);CloseHandle(job);return 125;}
        if ResumeThread(info.thread)==u32::MAX {TerminateJobObject(job,125);CloseHandle(info.thread);CloseHandle(info.process);CloseHandle(job);return 125;}
        CloseHandle(info.thread);
        let wait=WaitForSingleObject(info.process,60000);let mut code:u32=125;
        if wait==0 {GetExitCodeProcess(info.process,&mut code);}else{TerminateJobObject(job,124);code=124;}
        CloseHandle(job);CloseHandle(info.process);code as i32
    }}
    pub fn run() {
        let args:Vec<String>=std::env::args().collect();
        if args.get(1).map(|s|s.as_str())==Some("--job-run") {std::process::exit(job_run(&args[2..]));}
        if args.iter().any(|v| v=="--self-check") { assert_eq!(size_of::<Input>(),40);assert_eq!(size_of::<Startup>(),104);assert_eq!(size_of::<JobLimit>(),144);assert_eq!(vk("KeyA"),Some(65)); assert_eq!(vk("F12"),Some(123)); emit("{\"type\":\"self-check\",\"inputBytes\":40,\"jobBytes\":144}"); return; }
        unsafe { if SetProcessDpiAwarenessContext(-4)==0 {SetProcessDPIAware();} }
        if args.iter().any(|v|v=="--window-catalog") {window_catalog("probe");return;}
        STATE.set(Mutex::new(State{token:String::new(),sequence:0,heartbeat:std::time::Instant::now(),held_keys:HashSet::new(),held_buttons:HashSet::new()})).ok();
        let module=unsafe{GetModuleHandleW(null())};
        let mh=unsafe{SetWindowsHookExW(14,Some(mouse_hook),module,0)};
        let kh=unsafe{SetWindowsHookExW(13,Some(key_hook),module,0)};
        if mh.is_null() || kh.is_null() { emit("{\"type\":\"error\",\"error\":\"HOOK_UNAVAILABLE\"}"); return; }
        let mut token:Handle=null_mut();let mut elevated:u32=0;let mut returned:u32=0;
        let known=unsafe{OpenProcessToken(GetCurrentProcess(),8,&mut token)!=0 && GetTokenInformation(token,20,&mut elevated as *mut _ as *mut c_void,4,&mut returned)!=0};
        if !token.is_null(){unsafe{CloseHandle(token);}}
        if !known { emit("{\"type\":\"error\",\"error\":\"TOKEN_INSPECTION_FAILED\"}"); return; }
        emit(&format!("{{\"type\":\"ready\",\"elevated\":{}}}",elevated!=0));
        let cleanup=std::thread::spawn(|| loop {
            std::thread::park_timeout(std::time::Duration::from_millis(100));
            let mut state=STATE.get().unwrap().lock().unwrap();
            let context=TAKEOVER_CONTEXT.swap(0,Ordering::SeqCst);
            if context!=0 {
                ACTIVE.store(false,Ordering::SeqCst);release(&mut state);drop(state);
                emit(&format!("{{\"type\":\"takeover\",\"source\":\"{}\",\"injected\":{}}}",if context&3==1{"mouse"}else{"keyboard"},context&4!=0));
                continue;
            }
            if ACTIVE.load(Ordering::SeqCst) && state.heartbeat.elapsed().as_millis()>2000 {
                ACTIVE.store(false,Ordering::SeqCst);release(&mut state);drop(state);emit("{\"type\":\"error\",\"error\":\"WATCHDOG_EXPIRED\"}");
            }
        });
        CLEANUP_THREAD.set(cleanup.thread().clone()).ok();
        std::thread::spawn(|| {
            for line in io::stdin().lock().lines() {
                let line=match line {Ok(v) if v.len()<=512=>v,_=>break};
                let parts:Vec<&str>=line.split_whitespace().collect();
                if parts.is_empty() {continue;}
                if parts.len()==2 && parts[0]=="windows" && parts[1].len()<=32 && parts[1].chars().all(|ch|ch.is_ascii_alphanumeric()) {window_catalog(parts[1]);continue;}
                let mut state=STATE.get().unwrap().lock().unwrap();
                if parts[0]=="stop" {ACTIVE.store(false,Ordering::SeqCst);release(&mut state);continue;}
                if parts.len()==2 && parts[0]=="heartbeat" && ACTIVE.load(Ordering::SeqCst) && parts[1]==state.token {state.heartbeat=std::time::Instant::now();continue;}
                if parts.len()==2 && parts[0]=="begin" && parts[1].len()==36 { release(&mut state);state.token=parts[1].to_owned();state.sequence=0;state.heartbeat=std::time::Instant::now();ACTIVE.store(true,Ordering::SeqCst);continue; }
                if parts.len()<3 || !ACTIVE.load(Ordering::SeqCst) || parts[1]!=state.token {continue;}
                let seq=match parts[2].parse::<u64>() {Ok(n) if n>state.sequence=>n,_=>continue};
                state.sequence=seq;
                let ok=match parts[0] {
                    "window"=>window_input(&parts,&mut state),
                    "move"|"down"|"up" if parts.len()>=5=>{
                        let x=parts[3].parse::<i32>();let y=parts[4].parse::<i32>();
                        if x.is_err() || y.is_err() {continue;}
                        let (left,top,width,height)=unsafe{(GetSystemMetrics(76),GetSystemMetrics(77),GetSystemMetrics(78),GetSystemMetrics(79))};
                        if width<2 || height<2 {continue;}
                        let x=x.unwrap();let y=y.unwrap();
                        if x<left || y<top || x>=left+width || y>=top+height {continue;}
                        let moved=dispatch(mouse(0x8000|0x4000|1,0,((x-left) as i64*65535/(width-1) as i64) as i32,((y-top) as i64*65535/(height-1) as i64) as i32));
                        if parts[0]=="move" {moved} else {
                            let button=match parts.get(5).and_then(|n|n.parse::<u32>().ok()) {Some(n) if n<3=>n,_=>continue};
                            let up=parts[0]=="up";
                            if up {state.held_buttons.remove(&button);} else {state.held_buttons.insert(button);}
                            moved && dispatch(mouse(if up{[4,0x40,0x10][button as usize]}else{[2,0x20,8][button as usize]},0,0,0))
                        }
                    },
                    "release"=>{release(&mut state);true},
                    "paste"=>paste(&mut state),
                    "keydown"|"keyup" if parts.len()==4=>{let code=match vk(parts[3]){Some(v)=>v,None=>continue};let up=parts[0]=="keyup";if up{state.held_keys.remove(&code);}else{state.held_keys.insert(code);}dispatch(key(code,up))},
                    "wheel" if parts.len()==5=>{let dx=parts[3].parse::<i32>().unwrap_or(0).clamp(-1200,1200);let dy=parts[4].parse::<i32>().unwrap_or(0).clamp(-1200,1200);(dy==0||dispatch(mouse(0x0800,(-dy) as u32,0,0)))&&(dx==0||dispatch(mouse(0x1000,dx as u32,0,0)))},
                    _=>false
                };
                let acknowledged=ok && ACTIVE.load(Ordering::SeqCst);
                if !ok {ACTIVE.store(false,Ordering::SeqCst);release(&mut state);}
                drop(state);
                if acknowledged {emit(&format!("{{\"type\":\"ack\",\"sequence\":{}}}",seq));}
                if !ok {emit("{\"type\":\"error\",\"error\":\"INPUT_FAILED\"}");}
            }
            ACTIVE.store(false,Ordering::SeqCst);release(&mut STATE.get().unwrap().lock().unwrap());std::process::exit(0);
        });
        unsafe { let mut message:Message=zeroed();while GetMessageW(&mut message,null_mut(),0,0)>0{} UnhookWindowsHookEx(mh);UnhookWindowsHookEx(kh); }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn takeover_fences_without_waiting_for_dispatch_or_output_locks() {
            STATE.set(Mutex::new(State{token:String::new(),sequence:0,heartbeat:std::time::Instant::now(),held_keys:HashSet::new(),held_buttons:HashSet::new()})).ok();
            let dispatch_guard=STATE.get().unwrap().lock().unwrap();
            let output_guard=OUTPUT.lock().unwrap();
            ACTIVE.store(true,Ordering::SeqCst);
            let (sent,received)=std::sync::mpsc::channel();
            let hook=std::thread::spawn(move || {takeover("mouse",true);sent.send(()).unwrap();});
            let returned=received.recv_timeout(std::time::Duration::from_millis(500)).is_ok();
            drop(output_guard);drop(dispatch_guard);hook.join().unwrap();
            assert!(returned,"hook waited for dispatch/output locks");
            assert!(!ACTIVE.load(Ordering::SeqCst));
            assert_eq!(TAKEOVER_CONTEXT.load(Ordering::SeqCst),5);
            // Inactive late mouse movement and key-down events are suppressed.
            let mouse=MouseHook{point:Point{x:0,y:0},data:0,flags:1,time:0,extra:MARK};
            let key=KeyHook{vk:65,scan:0,flags:0x10,time:0,extra:MARK};
            unsafe {
                assert_eq!(mouse_hook(0,0x200,&mouse as *const _ as isize),1);
                assert_eq!(key_hook(0,0x100,&key as *const _ as isize),1);
            }
        }
    }
}
#[cfg(target_os = "windows")]
fn main() { windows::run(); }
