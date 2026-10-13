import { writeFileSync } from "node:fs";
const target=process.argv[2];
const update=()=>writeFileSync(target,JSON.stringify({pid:process.pid,revision:process.env.REVISION||"one",time:Date.now()}));
update();
const timer=setInterval(update,30);
process.on("SIGTERM",()=>{clearInterval(timer);process.exit(0);});
