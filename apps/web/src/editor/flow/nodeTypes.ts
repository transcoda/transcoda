import { TcEdge } from './TcEdge.tsx';
import { TcGroup } from './TcGroup.tsx';
import { TcLinkEdge } from './TcLinkEdge.tsx';
import { TcNode } from './TcNode.tsx';
import { TcValues } from './TcValues.tsx';

// Module constants: React Flow warns when these objects change between renders.
export const nodeTypes = { 'tc-node': TcNode, 'tc-group': TcGroup, 'tc-values': TcValues };
export const edgeTypes = { 'tc-edge': TcEdge, 'tc-link': TcLinkEdge };
