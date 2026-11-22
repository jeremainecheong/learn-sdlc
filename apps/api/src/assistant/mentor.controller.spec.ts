import 'reflect-metadata';
import { EventEmitter } from 'events';
import { MentorController } from './mentor.controller';
import { requestLogging } from '../observability/logger';

describe('stakeholder request diagnostic handoff',()=>{
  it('passes the middleware reference, not the hostile original header, to the interview service',()=>{
    const ask=jest.fn();
    const controller=new MentorController({ask} as never,{} as never,{} as never,{} as never);
    const req={headers:{'x-request-id':'private forged rid\nsecret'},method:'POST',originalUrl:'/api/v1/phases/phase/interview/ask',requestId:''};
    const res=Object.assign(new EventEmitter(),{statusCode:503,setHeader:jest.fn()});
    requestLogging({log:jest.fn(),warn:jest.fn(),error:jest.fn()})(req as never,res as never,()=>undefined);
    controller.ask({id:'learner'} as never,'phase',{question:'Hello'},req as never);
    expect(ask).toHaveBeenCalledWith('learner','phase','Hello',req.requestId);
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id',req.requestId);
    expect(req.requestId).not.toContain('secret');
  });
  it('keeps controller callers without an HTTP request compatible',()=>{
    const ask=jest.fn();
    const controller=new MentorController({ask} as never,{} as never,{} as never,{} as never);
    controller.ask({id:'learner'} as never,'phase',{question:'Hello'});
    expect(ask).toHaveBeenCalledWith('learner','phase','Hello',undefined);
  });
});
