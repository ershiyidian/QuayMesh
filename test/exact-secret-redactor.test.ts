import assert from "node:assert/strict";
import {test} from "node:test";
import {ExactSecretRedactor} from "../src/exact-secret-redactor.js";

const secret="qml1_"+"a".repeat(43), other="qml1_"+"b".repeat(43);

test("the exact issued credential is removed at every possible chunk split",()=>{
  for(let split=0;split<=secret.length;split++){
    const filter=new ExactSecretRedactor(secret);
    const chunks=["ordinary 雪 "+secret.slice(0,split),secret.slice(split)+" next "+other+"\n"];
    assert.equal(chunks.map(chunk=>filter.push(chunk)).join("")+filter.flush(),"ordinary 雪 [redacted] next "+other+"\n");
    assert.equal(filter.flush(),"");
  }
});

test("single-character chunks, repeated matches and EOF partial prefixes preserve ordinary output",()=>{
  const source="start="+secret+"\n"+secret+"|"+other+"\npartial=qml1_";
  const filter=new ExactSecretRedactor(secret);
  const output=Array.from(source,character=>filter.push(character)).join("");
  assert.equal(output.includes(secret),false);
  assert.equal(output+filter.flush(),source.replaceAll(secret,"[redacted]"));
  assert.equal(new ExactSecretRedactor(undefined).push(source),source);
});

test("independent streams retain their own prefix across interleaved output and flush on termination",()=>{
  const stdout=new ExactSecretRedactor(secret),stderr=new ExactSecretRedactor(secret);
  assert.equal(stdout.push("stdout:"+secret.slice(0,23)),"stdout:");
  assert.equal(stderr.push("stderr:"+secret.slice(0,17)),"stderr:");
  assert.equal(stdout.push(secret.slice(23)+"\n"),"[redacted]\n");
  assert.equal(stderr.push(secret.slice(17)+"\nlast=qml1_"),"[redacted]\nlast=");
  assert.equal(stdout.flush(),"");assert.equal(stderr.flush(),"qml1_");
});
