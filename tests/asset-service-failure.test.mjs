import test from 'node:test';
import assert from 'node:assert/strict';
import {assetServiceUnavailable,stopAssetTool} from '../lib/errors.mjs';
test('已耗尽重试的服务异常、DNS与超时可结束工具会话，参数与权限错误不按服务故障处理',()=>{
 for(const httpStatus of [429,500,502,503,504])assert(assetServiceUnavailable({httpStatus}));
 for(const httpStatus of [400,401,403,404,422])assert(!assetServiceUnavailable({httpStatus}));
 assert(assetServiceUnavailable(Error('fetch failed',{cause:{code:'ENOTFOUND'}})));assert(assetServiceUnavailable({code:'API_TIMEOUT'}));
 const original=Object.assign(Error('API返回503'),{httpStatus:503,retryable:true});const wrapped=stopAssetTool(original,{artistic:true});assert(wrapped.toolSessionStop);assert.equal(wrapped.httpStatus,503);assert.equal(wrapped.cause,original);assert.match(wrapped.message,/保留原页面/);assert.equal(original.toolSessionStop,undefined);
});
