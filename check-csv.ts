import { createReadStream } from 'fs';
import csv from 'csv-parser';
import { pipeline } from 'stream/promises';

const CSV_URL = 'https://lutner.ru/bitrix/catalog_export/upload/hour.csv';

async function checkCSV() {
    try {
        console.log('📥 Загрузка CSV для проверки...\n');
        const response = await fetch(CSV_URL);
        const csvText = await response.text();
        
        console.log('Первые 1000 символов CSV:');
        console.log(csvText.substring(0, 1000));
        console.log('\n---\n');
        
        const lines = csvText.split('\n').slice(0, 3);
        console.log('Строки:');
        lines.forEach((line, i) => console.log(`${i}: ${line.substring(0, 150)}`));
        
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

checkCSV();
