import type { TransformPlugin } from '../types'
import identity from './identity'
import rawJson from './raw-json'
import simpleCot from './simple-cot'

export const builtinTransforms: TransformPlugin[] = [identity, rawJson, simpleCot]
