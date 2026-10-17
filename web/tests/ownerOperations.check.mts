import {test} from 'node:test'
import assert from 'node:assert/strict'
import {webcrypto} from 'node:crypto'
import {operationLedger, operationKey} from '../src/collaboration/ownerOperations.ts'
import {authFetch, responseJson, responseText, setAuthContext, clearAuthContext} from '../src/collaboration/http.ts'

test('operation identity survives unknown body receipt; explicit successful repetitions get new IDs',async t=>{
  const values=new Map<string,string>()
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)}}
  const previousWindow=globalThis.window,previousFetch=globalThis.fetch
  Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true})
  globalThis.window={location:{href:'https://synthetic.invalid/',origin:'https://synthetic.invalid'},sessionStorage:storage} as unknown as Window & typeof globalThis
  t.after(()=>{clearAuthContext();globalThis.fetch=previousFetch;globalThis.window=previousWindow})
  setAuthContext({ok:true,mode:'collaboration',csrfToken:'synthetic-csrf',user:{id:'owner',role:'owner',username:'owner',displayName:'owner',disabled:false,projectIds:[]}})
  const ids:string[]=[],body=JSON.stringify({slug:'job',message:'继续'}),init={method:'POST',body}
  let failBody=true
  globalThis.fetch=async(_input,options)=>{
    ids.push(new Headers(options?.headers).get('X-Owner-Operation-Id')!)
    return failBody?new Response(new ReadableStream({start(controller){controller.error(new Error('receipt lost after headers'))}}),{status:200}):new Response('completed',{status:200})
  }
  const first=await authFetch('/api/codex/say?project=sample',init)
  assert.equal(values.size,1,'headers alone do not complete the operation')
  await assert.rejects(responseText(first))
  failBody=false
  assert.equal(await responseText(await authFetch('/api/codex/say?project=sample',init)),'completed')
  assert.equal(ids[0],ids[1])
  await responseText(await authFetch('/api/codex/say?project=sample',init))
  assert.notEqual(ids[1],ids[2])
  globalThis.fetch=async(_input,options)=>{ids.push(new Headers(options?.headers).get('X-Owner-Operation-Id')!);return new Response('{invalid',{status:200})}
  await assert.rejects(responseJson(await authFetch('/api/codex/dispatch?project=sample',init)))
  const badId=ids.at(-1)
  globalThis.fetch=async(_input,options)=>{ids.push(new Headers(options?.headers).get('X-Owner-Operation-Id')!);return Response.json({ok:true,slug:'job'})}
  await responseJson(await authFetch('/api/codex/dispatch?project=sample',init))
  assert.equal(ids.at(-1),badId)
  assert.doesNotMatch([...values.values()].join(''),/继续|synthetic-csrf|message/)
  setAuthContext({ok:true,mode:'local',user:null})
  globalThis.fetch=async(_input,options)=>{assert.equal(new Headers(options?.headers).has('X-Owner-Operation-Id'),false);return new Response('local')}
  assert.equal(await responseText(await authFetch('/api/codex/say',init)),'local')
})

test('uncertain IDs survive reloading the ledger, are user-scoped, and completion is conditional',async()=>{
  const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v)}}
  const a=await operationKey('owner-a','/api/codex/say','same'),b=await operationKey('owner-b','/api/codex/say','same')
  assert.notEqual(a,b)
  const first=operationLedger(storage,()=> 'first');assert.equal(first.begin(a),'first')
  const restarted=operationLedger(storage,()=> 'second');assert.equal(restarted.begin(a),'first')
  restarted.complete(a,'wrong');assert.equal(restarted.begin(a),'first')
  restarted.complete(a,'first');assert.equal(restarted.begin(a),'second')
})
