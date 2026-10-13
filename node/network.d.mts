import type { Socket } from "node:net";
import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
export function connectSocket(host:string, port:number, options?:{socksUrl?:string;timeoutMs?:number;signal?:AbortSignal}):Promise<Socket>;
export function createAgent(url:URL, options?:{socksUrl?:string;timeoutMs?:number}):HttpAgent|HttpsAgent;
export function requestJson(url:URL|string, options?:{method?:string;body?:unknown;token?:string;agent?:HttpAgent|HttpsAgent;timeoutMs?:number;signal?:AbortSignal;headers?:Record<string,string>}):Promise<any>;
export function probeHttp(url:URL|string,options?:Parameters<typeof requestJson>[1]):Promise<any>;
