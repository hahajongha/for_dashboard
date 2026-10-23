// Knowledge Graph '은하' 보기용 3D 번들: 3d-force-graph(three.js 포함)와 화면이 직접 쓰는 three 클래스만 내보낸다
import ForceGraph3D from '3d-force-graph';
import { Mesh, SphereGeometry, MeshBasicMaterial, MeshLambertMaterial, Vector3, Color } from 'three';
window.KG3D = Object.freeze({ ForceGraph3D, Mesh, SphereGeometry, MeshBasicMaterial, MeshLambertMaterial, Vector3, Color });
