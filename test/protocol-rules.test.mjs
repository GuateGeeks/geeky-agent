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

test('el prompt fija el orden de construcción y prohíbe pedir identificadores internos', () => {
 assert.match(instructions, /1\) niveles; 2\) estudiantes por grado/);
 assert.match(instructions, /sin matrícula no se puede agregar ningún programa/);
 assert.match(instructions, /nunca se los pidas a la persona/);
 assert.match(instructions, /todavía no existe el programa, no pidas ningún identificador/);
});

test('el prompt indica la sección por defecto de cada grado y cómo agregar programas', () => {
 assert.match(instructions, /ya trae una sección por defecto en groups/);
 assert.match(instructions, /nunca digas que falta una sección/);
 assert.match(instructions, /regístralo en TODOS los grados de ese nivel con UNA sola acción set_level_students/);
 assert.match(instructions, /un add_program por programa/);
 assert.match(instructions, /Nunca digas "restaurado"/);
});

test('el prompt sincroniza la vista con el paso y fija el flujo de venta', () => {
 assert.match(instructions, /1 Niveles, 2 Estudiantes, 3 Programas, 4 Personalizar \(modalidad\), 5 Resumen/);
 assert.match(instructions, /ofrece un promedio por grado como opción/);
 assert.match(instructions, /comprar \(INTEGRA\), rentar \(FLEX, por bimestres\) o pagar en cuotas \(EV8 u EV16\)/);
 assert.match(instructions, /Mantén la vista sincronizada con el paso en curso/);
 assert.doesNotMatch(instructions, /abre Propuesta automáticamente/);
});

test('el prompt aplica el promedio a todos los grados con acciones existentes, en serie, y pregunta la cifra cuando falta', () => {
 assert.match(instructions, /args levelId y students/);
 assert.match(instructions, /cada nivel \(preprimaria, primaria, básico, bachillerato\) con su propio número/);
 assert.match(instructions, /de una en una: espera cada resultado y usa la revisión que devuelve/);
 assert.match(instructions, /usa set_students solo en los grados que mencione/);
 assert.match(instructions, /pregunta una sola cosa: cuántos por grado o, si no sabe, un promedio por grado/);
 assert.match(instructions, /no registres nada ni supongas cifras/);
});

test('el prompt omite los grados que la institución no tiene y sigue con lo que indique la persona', () => {
 assert.match(instructions, /"no tenemos 6\.º primaria"/);
 assert.match(instructions, /omítelo pasando excludeGradeIds en la misma acción set_level_students/);
});

test('el prompt muestra solo lo permitido, no da totales parciales y deriva a WhatsApp', () => {
 assert.match(instructions, /Muestra y ofrece solo lo que el cotizador permite/);
 assert.match(instructions, /no des cifras parciales/);
 assert.match(instructions, /# AYUDA POR WHATSAPP/);
 assert.match(instructions, /\+502 3004 4972/);
 assert.match(instructions, /https:\/\/wa\.me\/50230044972/);
});

test('compatibilidad con el cotizador: set_level_students existe desde ?v=170 y no hay otras acciones nuevas', async () => {
 const { TOOLS } = await import('../src/protocol.mjs');
 const actions = TOOLS.find(tool => tool.name === 'update_cotizador').parameters.properties.action.enum;
 assert.deepEqual(actions, ['set_levels','set_students','set_level_students','add_section','remove_section','add_program','remove_program','set_program_groups','set_schedule','set_equipment','set_modality','set_tax','set_projection','navigate','calculate']);
 assert.match(instructions, /excludeGradeIds/);
});

test('el sobre de update_cotizador exige expectedRevision y lo explica con un ejemplo', async () => {
 const { TOOLS } = await import('../src/protocol.mjs');
 const update = TOOLS.find(tool => tool.name === 'update_cotizador');
 assert.deepEqual(update.parameters.required, ['action', 'args', 'expectedRevision']);
 assert.match(update.description, /ALWAYS send the three top-level fields together: action, args and expectedRevision/);
 assert.match(update.description, /"expectedRevision":4/);
 assert.match(update.parameters.properties.expectedRevision.description, /REQUIRED/);
});

test('el prompt corrige invalid_arguments sin repetir la misma llamada y verifica la matrícula antes de confirmarla', () => {
 assert.match(instructions, /lleva siempre los tres campos action, args y expectedRevision/);
 assert.match(instructions, /si el resultado es invalid_arguments|Si el resultado es invalid_arguments/);
 assert.match(instructions, /nunca repitas la misma llamada idéntica/);
 assert.match(instructions, /compara el contexto devuelto: confirma solo los grados cuyo students ya tiene la cifra pedida/);
});
