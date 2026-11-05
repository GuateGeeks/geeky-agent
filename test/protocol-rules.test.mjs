import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionConfig } from '../src/protocol.mjs';

const instructions = sessionConfig().instructions;

test('el prompt fija los grados permitidos por programa y la recomendación de SPIKE Prime', () => {
 assert.match(instructions, /grados permitidos/);
 assert.match(instructions, /Tale-Bot es solo para preprimaria/);
 assert.match(instructions, /drones, de 4\.º primaria a bachillerato/);
 assert.match(instructions, /realidad virtual, solo básico y bachillerato por seguridad/);
 assert.match(instructions, /SPIKE Prime se recomienda de 4\.º primaria a bachillerato/);
 assert.match(instructions, /recommendedGrades/);
 assert.match(instructions, /outsideRecommended/);
});

test('el prompt permite programas distintos por nivel y no extiende uno a otros niveles', () => {
 assert.match(instructions, /Cada nivel puede llevar programas distintos o ninguno/);
 assert.match(instructions, /nunca lo extiendas a otros niveles por tu cuenta/);
 assert.doesNotMatch(instructions, /único grupo compatible/);
});
