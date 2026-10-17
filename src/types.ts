export type Source = 'gmail' | 'outlook' | 'calendar' | 'github' | 'slack' | 'manual';
export type Priority = 'now' | 'soon' | 'later';
export type AiProvider = 'rules'|'chatgpt-subscription'|'openai'|'anthropic'|'openai-compatible';
export interface Signal { id:string; source:Source; sender:string; title:string; summary:string; occurredAt:string; category:string; priority:Priority; read:boolean; metadata?:Record<string,unknown> }
export interface Task { id:string; title:string; note?:string; dueAt?:string; priority:Priority; status:'open'|'done'|'snoozed'; source:Source }
export interface Connection { id:string; provider:Source; label:string; accountEmail?:string; status:'connected'|'available'|'coming_soon'|'error'; lastSyncedAt?:string }
export interface Dashboard { user:{name:string;email:string;avatar?:string}; mode:'demo'|'live'; greeting:string; brief:{headline:string;narrative:string;wins:string[];watchouts:string[];generatedAt:string}; signals:Signal[]; tasks:Task[]; connections:Connection[]; settings:{aiProvider:AiProvider;aiInputChars:number;chatgptModel?:string}; system:{storage:'postgres'|'memory';persistent:boolean;aiProviders:Array<{id:AiProvider;label:string;configured:boolean;external:boolean}>;chatgpt:{connected:boolean;email?:string;hostId?:string}}; stats:{needsYou:number;waitingOn:number;cleared:number;noiseFiltered:number} }
