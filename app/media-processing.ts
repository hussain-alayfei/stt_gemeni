// Client-only MP4 audio extraction with memory-bounded input reads.
const LIMIT = 2_700_000; // Leaves room for request metadata under Vercel's 4MB limit.
const MAX_SECONDS = 360;
const DIRECT = new Set(["wav","mp3","aiff","aif","aac","ogg","flac","mpeg","m4a","opus","webm","l16","alaw","mulaw"]);
const MP4 = new Set(["mp4","mov","m4v","3gp"]);
const ext = (name: string) => name.split(".").pop()?.toLowerCase() || "";
const stem = (name: string) => name.replace(/\.[^.]+$/, "") || "audio";

function packAac(data: Uint8Array, rate: number, channels: number, aot: number) {
  const rates = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
  const index = rates.indexOf(rate);
  const length = data.byteLength + 7;
  if (aot !== 2 || index < 0 || channels < 1 || channels > 7 || length > 8191) {
    throw new Error("Unsupported AAC format");
  }
  const bytes = new Uint8Array(length);
  bytes.set([255,241,((aot-1)<<6)|(index<<2)|(channels>>2),((channels&3)<<6)|(length>>11),(length>>3)&255,((length&7)<<5)|31,252]);
  bytes.set(data,7);
  return bytes;
}

async function extractAac(file: File, onProgress: (n:number)=>void): Promise<File[]> {
  const { createFile } = await import("mp4box");
  const mp4 = createFile(false);
  const output: File[] = [];
  let frames: Uint8Array[] = [];
  let total = 0, duration = 0, rate = 0, channels = 0, aot = 0, count = 0;
  let failure: Error | undefined;
  let unsupported = false;
  const flush = () => {
    if (!frames.length) return;
    output.push(new File(frames.map(x=>new Uint8Array(x)), `${stem(file.name)}-${output.length+1}.aac`, {type:"audio/aac"}));
    frames = []; total = 0; duration = 0;
  };
  mp4.onError = (error) => {failure = new Error(String(error));};
  mp4.onReady = (info) => {
    const track = info.audioTracks?.[0];
    if (!track) {failure = new Error("No audio track in this video."); return;}
    rate = track.audio?.sample_rate ?? 0;
    channels = track.audio?.channel_count ?? 0;
    aot = Number(track.codec?.match(/^mp4a\.40\.(\d+)$/)?.[1] || 0);
    if (aot !== 2 || !rate || !channels) {unsupported = true; return;}
    mp4.setExtractionOptions(track.id, null, {nbSamples: 100, rapAlignement: false});
    mp4.start();
  };
  mp4.onSamples = (id, _user, samples) => {
    for (const sample of samples) {
      if (failure) break;
      try {
        const frame = packAac(new Uint8Array(sample.data), rate, channels, aot);
        const seconds = sample.duration/sample.timescale;
        if (frames.length && (total+frame.length>LIMIT || duration+seconds>MAX_SECONDS)) flush();
        frames.push(frame); total+=frame.length; duration+=seconds;
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Failed reading compressed audio.");
      }
    }
    count += samples.length;
    mp4.releaseUsedSamples(id,count);
  };
  const step = 1024*1024;
  for (let offset=0; offset<file.size; offset+=step) {
    if (failure || unsupported) break;
    const chunk = await file.slice(offset,Math.min(file.size,offset+step)).arrayBuffer() as ArrayBuffer & {fileStart:number};
    chunk.fileStart = offset;
    mp4.appendBuffer(chunk);
    onProgress(Math.min(99,Math.round((offset+chunk.byteLength)/file.size*100)));
  }
  if (unsupported) throw new Error("The audio codec needs conversion.");
  if (failure) throw failure;
  mp4.flush();
  if (failure) throw failure;
  flush();
  if (!output.length) throw new Error("No audio could be extracted.");
  onProgress(100);
  return output;
}

async function ffmpegFallback(file: File, onProgress: (n:number)=>void): Promise<File[]> {
  const [{ FFmpeg }, { fetchFile,toBlobURL }] = await Promise.all([import("@ffmpeg/ffmpeg"),import("@ffmpeg/util")]);
  const ffmpeg = new FFmpeg();
  let failure = "";
  ffmpeg.on("log",({message})=>{if (/error|invalid|unsupported|failed|out of memory/i.test(message)) failure=message.slice(0,180);});
  ffmpeg.on("progress",({progress})=>onProgress(Math.min(99,Math.max(0,Math.round(progress*100)))));
  try {
    const base="https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
    await ffmpeg.load({
      coreURL: await toBlobURL(base+"/ffmpeg-core.js","text/javascript"),
      wasmURL: await toBlobURL(base+"/ffmpeg-core.wasm","application/wasm"),
    });
    const input="source."+ext(file.name);
    await ffmpeg.writeFile(input,await fetchFile(file));
    const code=await ffmpeg.exec(["-nostdin","-i",input,"-map","0:a:0","-vn","-sn","-dn","-ac","1","-ar","16000","-c:a","libmp3lame","-b:a","48k","-f","segment","-segment_time","360","-reset_timestamps","1","part-%03d.mp3"]);
    if (code!==0) throw new Error(failure || "Audio codec not supported.");
    const names=(await ffmpeg.listDir("/")).map(x=>x.name).filter(x=>/^part-\d+\.mp3$/.test(x)).sort();
    if (!names.length) throw new Error("No audio track was found.");
    const chunks: File[]=[];
    for (const name of names) {
      const data=await ffmpeg.readFile(name);
      if(typeof data==="string") continue;
      const bytes = new Uint8Array(data);
      if (bytes.byteLength>4*1024*1024) throw new Error("Converted audio segment is too large.");
      chunks.push(new File([bytes],`${stem(file.name)}-${name}`,{type:"audio/mpeg"}));
    }
    onProgress(100);
    return chunks;
  } catch(e) {
    const reason=e instanceof Error?e.message:String(e);
    if(/memory|out of bounds|abort\(/i.test(reason)) throw new Error("Browser ran out of conversion memory; extract audio using a desktop application.");
    throw new Error("Audio conversion failed: "+reason);
  } finally {ffmpeg.terminate();}
}

// Serialize heavy preparation, but allow the network requests of other files in parallel.
let pending=Promise.resolve();
async function oneAtATime<T>(task:()=>Promise<T>): Promise<T> {
  const previous=pending;
  let release!:()=>void;
  pending=new Promise<void>(resolve=>{release=resolve;});
  await previous;
  try{return await task();} finally{release();}
}

export async function prepareMedia(file: File,onProgress:(n:number)=>void):Promise<File[]> {
  const extension=ext(file.name);
  if(DIRECT.has(extension) && file.size<=4*1024*1024) return [file];
  return oneAtATime(async()=>{
    if (MP4.has(extension)) {
      try{return await extractAac(file,onProgress);}
      catch(error) {
        if(error instanceof Error && /no audio track|no audio could/i.test(error.message)) throw error;
        console.warn("AAC passthrough unavailable. Trying fallback:",error);
        onProgress(0);
      }
    }
    return ffmpegFallback(file,onProgress);
  });
}
