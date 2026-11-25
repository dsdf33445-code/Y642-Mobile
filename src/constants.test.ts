import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsvToMatrix,
  convertMatrixToProducts,
  mergeMoLineItems,
} from './constants';
import type { WorkOrder } from './types';

test('parseCsvToMatrix parses CSV rows and quoted commas properly', () => {
  const csv = '項目編號,項目名稱,單價\r\nA001,"配線, 2mm",120\r\nA002,開關,80';
  const matrix = parseCsvToMatrix(csv);
  assert.equal(matrix.length, 3);
  assert.deepEqual(matrix[1], ['A001', '配線, 2mm', '120']);
});

test('convertMatrixToProducts extracts code, name, and unitPrice from matrix', () => {
  const matrix = [
    ['項目編號', '項目名稱', '單價'],
    ['Y6N10C0001A0', '導線2 mm2及以下', '41.6'],
    ['Y6N10C0001B0', '導線2 mm2及以下', '20.8'],
  ];
  const products = convertMatrixToProducts(matrix, 'C01');
  assert.equal(products.length, 2);
  assert.equal(products[0].code, 'Y6N10C0001A0');
  assert.equal(products[0].unitPrice, 41.6);
});

test('mergeMoLineItems combines duplicate items and sorts by code', () => {
  const orders: WorkOrder[] = [
    {
      id: 'wo-1',
      woNumber: 'W6220001A',
      title: '工令一',
      ownerId: 'u1',
      ownerName: 'User',
      contractId: 'contract-1',
      status: '進行中',
      items: [
        {
          id: 'i-1',
          code: 'B002',
          name: '項目B',
          spec: '',
          unit: '式',
          unitPrice: 100,
          quantity: 2,
          subtotal: 200,
        },
      ],
      totalAmount: 200,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'wo-2',
      woNumber: 'W6220002A',
      title: '工令二',
      ownerId: 'u1',
      ownerName: 'User',
      contractId: 'contract-1',
      status: '進行中',
      items: [
        {
          id: 'i-2',
          code: 'B002',
          name: '項目B',
          spec: '',
          unit: '式',
          unitPrice: 100,
          quantity: 3,
          subtotal: 300,
        },
        {
          id: 'i-3',
          code: 'A001',
          name: '項目A',
          spec: '',
          unit: '式',
          unitPrice: 50,
          quantity: 1,
          subtotal: 50,
        },
      ],
      totalAmount: 350,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const merged = mergeMoLineItems(orders);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].code, 'A001');
  assert.equal(merged[1].code, 'B002');
  assert.equal(merged[1].quantity, 5);
  assert.equal(merged[1].subtotal, 500);
});
