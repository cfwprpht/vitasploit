/*
   Samples for ROP
*/

/*
   Connect to ip on given port and send message
*/
function socket_send(ip, port, msg)
{
    var scenet = libraries.SceNet.functions;
    var sockaddr = allocate_memory(32); 

    mymemset(sockaddr, 0, SIZEOF_SIN);

    aspace[sockaddr] = SIZEOF_SIN;
    aspace[sockaddr + 1] = SCE_NET_AF_INET;

    var PORT = port;
    logdbg("Calling nethtons()");
    var r = scenet.sceNetHtons(PORT); 
    logdbg("-> 0x" + r.toString(16) + "\n"); 
    aspace16[((sockaddr + 2) / 2)] = r;

    aspace32[(sockaddr + 4) / 4] = inet_addr(ip);

    var dbgname = "test_socket\x00";
    var dbgnameaddr = allocate_memory(dbgname.length);

    mymemcpy(dbgnameaddr, dbgname, dbgname.length);

    logdbg("Calling SceNetSocket()");
    var sockfd = scenet.sceNetSocket(dbgnameaddr, SCE_NET_AF_INET, SCE_NET_SOCK_STREAM, 0);
    logdbg("-> 0x" + sockfd.toString(16) + "\n"); 

    logdbg("Calling SceNetConnect()");
    var r = scenet.sceNetConnect(sockfd, sockaddr, SIZEOF_SIN); 
    logdbg("-> 0x" + r.toString(16) + "\n"); 

    var msgaddr = allocate_memory(msg.length);

    mymemcpy(msgaddr, msg, msg.length);

    logdbg("Calling SceNetSend()");
    var sent = scenet.sceNetSend(sockfd, msgaddr, msg.length, 0);
    logdbg("-> 0x" + sent.toString(16) + "\n"); 

    logdbg("Calling SceNetClose()");
    var sent = scenet.sceNetSocketClose(sockfd, 0, 0, 0);
    logdbg("-> 0x" + sent.toString(16) + "\n"); 
}

/*
    List Directory
*/
function list_dir(dirname)
{
    var scekernel = libraries.SceLibKernel.functions;

    var dirname_a = allocate_memory(0x20);
    var dirlist = allocate_memory(0x1000);

    mymemcpy(dirname_a, dirname, dirname.length);

    var fd = scekernel.sceIoDopen(dirname_a);
    fd = Int(fd);
    if(fd < 0){
        logdbg("sceIoDopen() failed");
        return;
    }

    logdbg("Listing: " + dirname);
    while (scekernel.sceIoDread(fd, dirlist) > 0){
        myprintf(dirlist + 0x58);
    }
    logdbg("-\n");
}

/*
    Retrieve the file fname and save to dumps/loc_name
*/
function retrieve_file(fname, loc_name)
{
    var scelibc = libraries.SceLibc.functions;
    var BUFSIZE = 0x1000;

    var fname_a = allocate_memory(fname.length + 1);
    mymemcpy(fname_a, fname + "\x00", fname.length);

    var mode = "r";
    var mode_a = allocate_memory(mode.length + 1);
    mymemcpy(mode_a, mode + "\x00", mode.length);
	
    var fp = scelibc.fopen(fname_a, mode_a);
    fp = Int(fp);
    if (fp == 0)
	{
        logdbg("fopen() failed");
        return; 
    }
	
    var buf = allocate_memory(BUFSIZE);
    var n = 0;
    while ((n = scelibc.fread(buf, 1, BUFSIZE, fp)) > 0)
	{
        logdbg("-> 0x" + n.toString(16));
        var bytes = get_bytes(aspace, buf, n);
        sendcmsg("dump", buf, bytes, loc_name); 
    }
}

/*
    List and dump all visible modules using SceLibKernel syscalls
*/
function list_modules(doDump)
{
	var scekernel = libraries.SceLibKernel.functions;
	
	var MAX_MODULES = 0x80;
	var MOD_INFO_SIZE = 0x1B8;
    var mod_list_addr = allocate_memory(MAX_MODULES * 4);
	var mod_info_addr = allocate_memory(MOD_INFO_SIZE * 4);
    var mod_num_addr = allocate_memory(0x4);
    aspace32[mod_num_addr / 4] = MAX_MODULES;
	
	var mod_segments = [];
    var mod_offsets = {};
    var mod_sizes = {};

    var list_result = scekernel.sceKernelGetModuleList(0xFF, mod_list_addr, mod_num_addr);
	
    if (list_result != 0x0)
	{
		logdbg("Error: 0x" + list_result.toString(16));
        return aspace
	}
	
	logdbg("Module UIDs: ");
	var mod_num = aspace32[mod_num_addr / 4];
    do_read(aspace, mod_list_addr, mod_num * 4);

    for (var i = 0; i < mod_num * 4; i += 4)
	{
		var info_result = scekernel.sceKernelGetModuleInfo(aspace32[(mod_list_addr + i) / 4], mod_info_addr);
        
		if (info_result != 0x0)
		{
			logdbg("Error: 0x" + info_result.toString(16));
			continue;
        }
		
        var mod_seg_info_addr = mod_info_addr + 0x154;
        var mod_name_addr = mod_info_addr + 0xC;
		var mod_name = read_string(mod_name_addr);
        
		logdbg("Found module: " +  mod_name);
        for (var j = 0; j <= 4; j++)
		{
			var mod_seg_addr = mod_seg_info_addr + j * 0x18;
			
			if (aspace32[(mod_seg_addr) / 4] != 0x18)
				continue;
                
            logdbg("Module segment info: #" + j);
            var mod_vaddr = aspace32[(mod_seg_addr + 8) / 4];
            var mod_memsz = aspace32[(mod_seg_addr + 12) / 4];
            logdbg("Module segment vaddr: 0x" + mod_vaddr.toString(16));
            logdbg("Module segment memsz: 0x" + mod_memsz.toString(16));
			
			mod_segments.push([mod_vaddr, mod_memsz, mod_name]);
            mod_offsets[mod_name + ".seg"+ j.toString()] = mod_vaddr;
            mod_sizes[mod_name + ".seg"+ j.toString()] = mod_memsz;
			
			if (doDump)
				do_dump(aspace, mod_vaddr, mod_memsz, mod_name + ".seg" + j.toString()+ ".bin");
        }
	}
	return [mod_segments, mod_offsets, mod_sizes];
}

/*
    Brute-force load all possible user modules using sceSysmoduleLoadModule and sceSysmoduleLoadModuleWithArgs
*/
function load_sysmodules()
{
	var scewkproc = libraries.SceWebKitProcess.functions;
	var scecdiag = libraries.SceCommonDialog.functions;
	
	var mod_start_ptr = allocate_memory(0x100);
	
	// sceSysmoduleLoadModule can load a few modules
	for (var i = 1; i < 0x100; i++)
	{
		var load_result = scewkproc.sceSysmoduleLoadModule(i);
		logdbg("sceSysmoduleLoadModule(#" + i.toString() + "): 0x" + load_result.toString(16));
	}
	
	// sceSysmoduleLoadModuleWithArgs can load modules by ID
	// WARNING: Loading modules with this function may crash the Vita's LiveArea
	for (var k1 = 0x80000000; k1 < 0x800000ff; k1++)
	{
		if (k1 != 0x80000008 && k1 != 0x80000012)
		{
			var loadargs_result1 = scecdiag.sceSysmoduleLoadModuleWithArgs(k1, 0, 0, mod_start_ptr);
			logdbg("sceSysmoduleLoadModuleWithArgs(0x" + k1.toString(16) + "): 0x" + loadargs_result1.toString(16));
        }
    }
	
	// Reload all modules to resolve dependencies
	for (var k2 = 0x80000000; k2 < 0x800000ff; k2++)
	{
		if (k2 != 0x80000008 && k2 != 0x80000012)
		{
			var loadargs_result2 = scecdiag.sceSysmoduleLoadModuleWithArgs(k2, 0, 0, mod_start_ptr);
			logdbg("sceSysmoduleLoadModuleWithArgs(0x" + k2.toString(16) + "): 0x" + loadargs_result2.toString(16));
        }
    }
	
	// Module 0x80000008 (ScePaf) has special arguments
	var scepaf_argc = 0x14;
	var scepaf_argp = allocate_memory(scepaf_argc);
	aspace32[(scepaf_argp) / 4] = 0x00300000;
	aspace32[(scepaf_argp + 4) / 4] = 0x00000000;
	aspace32[(scepaf_argp + 8) / 4] = 0x00000000;
	aspace32[(scepaf_argp + 12) / 4] = 0x0000000d;
	aspace32[(scepaf_argp + 16) / 4] = 0x00000000;
			
	var scepaf_result = scecdiag.sceSysmoduleLoadModuleWithArgs(0x80000008, scepaf_argc, scepaf_argp, mod_start_ptr);
	logdbg("sceSysmoduleLoadModuleWithArgs(0x80000008): 0x" + scepaf_result.toString(16));
	
	// Reload all modules again (except 0x8000000d)
	for (var k3 = 0x80000000; k3 < 0x800000ff; k3++)
	{
		if (k3 != 0x80000008 && k3 != 0x8000000d && k3 != 0x80000012)
		{
			var loadargs_result3 = scecdiag.sceSysmoduleLoadModuleWithArgs(k3, 0, 0, mod_start_ptr);
			logdbg("sceSysmoduleLoadModuleWithArgs(0x" + k3.toString(16) + "): 0x" + loadargs_result3.toString(16));
        }
    }
		
	/* 
	Missing modules:
	
	-> Error 0x80024804 (unknown):
		0x80000005, 0x80000006, 0x80000009, 0x8000000a, 0x8000000b, 0x8000000c
	
	-> Crash:
		0x8000000d, 0x80000012
		
	-> Error 0x8002d003 (no library):
		0x8000000e, 0x8000000f, 0x80000010, 0x80000011, 0x80000013, 0x80000014, 0x80000015
		0x80000016, 0x80000017, 0x80000018, 0x8000001a, 0x80000021, 0x80000022, 0x80000026
	
	-> Error 0x80010002 (no entry):
		0x80000019, 0x8000001c
		   
	-> Error 0x8002d013 (old library):
		0x8000001d
		   
	-> Error 0x800f0b34 (unknown):
		0x80000028, 0x80000029
	*/
}

/*
	Test SceLibKernel memory allocation
*/
function mem_test(mname, mtype, msize)
{
	var scekernel = libraries.SceLibKernel.functions;
	
	var mname_addr = allocate_memory(mname.length + 1);
	var mbase_ptr_addr = allocate_memory(0x4);
	mymemcpy(mname_addr, mname + "\x00", mname.length);
	
	var muid = scekernel.sceKernelAllocMemBlock(mname_addr, mtype, msize, 0);
	logdbg("Allocated memory UID: 0x" + muid.toString(16));
	
	var base_result = scekernel.sceKernelGetMemBlockBase(muid, mbase_ptr_addr);
	
	if (base_result != 0x0)
	{
		logdbg("Error: 0x" + base_result.toString(16));
        return aspace
	}
	
	logdbg("Memory base pointer: 0x" + mbase_ptr_addr.toString(16));
	
	var free_result = scekernel.sceKernelFreeMemBlock(muid);
	
	if (free_result != 0x0)
	{
		logdbg("Error: 0x" + free_result.toString(16));
        return aspace
	}
	
	logdbg("Freed memory UID: 0x" + muid.toString(16));
}

/*
	Call support URI
*/
function support_uri(cmd)
{
	var sceapputil = libraries.SceAppUtil.functions;
	
	var uri_addr = allocate_memory(0x100);
	mymemcpy(uri_addr, cmd, cmd.length);

	var result = sceapputil.sceCallSupportUri(0x40000, uri_addr);
	logdbg("sceCallSupportUri: 0x" + result.toString(16));
}