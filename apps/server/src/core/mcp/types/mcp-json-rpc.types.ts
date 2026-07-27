export type JsonRpcId = string | number | null;

export type McpJsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type McpJsonRpcSuccess = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
};

export type McpJsonRpcError = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type McpJsonRpcResponse = McpJsonRpcSuccess | McpJsonRpcError | null;
